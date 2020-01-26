const rp = require('request-promise');
const cheerio = require('cheerio');
const convert = require('xml2js');
const { parse } = require('url');
const { backOff } = require('exponential-backoff');

const xml2js = new convert.Parser();
const js2xml = new convert.Builder();

const RSS_URL = 'https://www.mangaupdates.com/rss.php';
const LIST_URL = 'https://www.mangaupdates.com/mylist.html';
const SERIES_URL = 'https://www.mangaupdates.com/releases.html'

function collectListData(id, list) {
  return new Promise((resolve, reject) => {
    rp(LIST_URL + "?id=" + id + "&list=" + list)
      .then(html => {
        const $ = cheerio.load(html);
        const entries = $('table[id=ptable] > tbody > tr:not(:first-child)');
        const seriesList = [];
        entries.each((_, tr) => {
          const tds = $(tr).children();
          seriesList.push({
            id: parse(tds.eq(0).children('a').attr('href'),true).query.id,
            series: tds.eq(0).text(),
            status: tds.eq(1).text()
          });
        });
        resolve(seriesList);
      })
      .catch(err => reject(err));
  });
}

function getSeriesData(id) {
  return backOff(_ => new Promise((resolve, reject) => {
    rp(SERIES_URL + "?search=" + id + "&stype=series&perpage=5")
      .then(html => {
        const $ = cheerio.load(html);
        const entries = $('div[id=main_content] > div:not(:first-child) > div > div.text:not(.releasestitle):not(.p-1)');
        const releases = [];

        var release = [];
        entries.each((_, col) => {
          const txt = $(col);
          release.push(txt)
          if (release.length >= 5) {
            releases.push({
              date: new Date(release[0].text()).toISOString(),
              series: release[1].text(),
              volume: release[2].text(),
              chapter: release[3].text(),
              group: release[4].text(),
              seriesid: parse(release[1].children('a').attr('href'),true).query.id,
              groupid: parse(release[4].children('a').attr('href'),true).query.id,
              serieshtml: release[1].html(),
              grouphtml: release[4].html(),
              serieslink: release[1].children('a').attr('href'),
              grouplink:release[4].children('a').attr('href'),
            });
            release = []
          }
        });
        resolve(releases);
      })
      .catch(err => reject(err));
  }))
}

function collectSeriesData(list){
  const errs = []
  return Promise.all(list.map(data => {
    return new Promise(resolve => setTimeout(resolve,100))
      .then(_ => getSeriesData(data.id))
      .then(releaseData => releaseData.map(release => {
        volumeStr = release.volume.length > 0 ? "v."+release.volume+" ":""
        chapterStr = "c."+release.chapter
        return{
          title: release.series+" "+volumeStr+chapterStr,
          description: "["+release.grouphtml+"] "+release.serieshtml+" "+volumeStr+chapterStr,
          date: release.date,
          url: release.serieslink,
          guid: release.seriesid+":"+release.groupid+":"+volumeStr+chapterStr,
        }
      }))
      .catch(err => {
        console.log("ERR",err)
        errs.push(err)
        return []
      })
  }))
  .then(releases => {
    console.log("ERRS",errs.length)
    return Promise.resolve(releases.flat(1).sort((a,b)=> {
      return new Date(a.date) <= new Date(b.date)?1:-1
    }))
  })
}

function generateRSS(res, releases) {
  return new Promise((resolve, reject) => {
    rp(RSS_URL)
      .then(xml => {
        xml2js.parseString(xml, (err, result) => {
          if (err) {
            reject(err);
          } else {
            result.rss.channel[0].item = releases.map(release => {
              return {
                title: release.title,
                guid: release.guid,
                url: release.url,
                pubDate: release.date,
                description: release.description,
              }
            })
            res.setHeader('Content-Type', 'text/xml');
            resolve(js2xml.buildObject(result));
          }
        });
      })
      .catch(err => reject(err));
  });
}

module.exports = (req, res) => {
  const { query } = parse(req.url, true);
  const { id, list } = query;
  collectListData(id, list)
    .then(list => collectSeriesData(list))
    .then(release => generateRSS(res, release))
    .then(list => res.send(list))
    .catch(err => res.send(err))
};
