import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as url from 'url';

import { inspect } from 'util';

import { BareWebServer, respond_error } from './bare-web-server.js';
import * as near from './near-api/near-rpc.js';
import * as network from './near-api/network.js';
import { spawnSync, spawnAsync, removeColors } from './util/spawn.js';

const NETWORK = "guildnet"
//@ts-ignore
const SUFFIX = NETWORK=="mainnet"? "near" : NETWORK;
network.setCurrent(NETWORK)
const homedir = require('os').homedir()
const MASTER_ACCOUNT = `luciotato.${SUFFIX}`
const CREDENTIALS_FILE = path.join(homedir,`.near-credentials/${NETWORK}/${MASTER_ACCOUNT}.json`)

let testMode = process.argv[2]=="test"

const StarDateTime = new Date()
let TotalPollingCalls = 0
let TotalNotValidating = 0
let TotalRestarts = 0
let TotalPings = 0
let TotalRestartsBcTime = 0
let TotalRestartsBecauseErrors = 0

//---------------------
function sp_contract(vindex:number): string{
  return "staking-pool-"+vindex+"."+NETWORK;
}

//---------------------
function getVindexFromQuery(urlParts:url.UrlWithParsedQuery, resp: http.ServerResponse): number {
  if (typeof urlParts.query["q"] != "string") {
    resp.end("query must be 1-5 and received:" + JSON.stringify(urlParts.query) + (typeof urlParts.query));
    return 0;
  }
  else {
    let vindex = parseInt(urlParts.query["q"]);
    if (isNaN(vindex) || vindex < config.from || vindex > config.to) {
      resp.end(`vindex must be ${config.from}-${config.to} and received: ${urlParts.query}`);
      return 0;
    }
    return vindex;
  }
}

//------------------------------------------
//Main HTTP-Request Handler - stats server
//------------------------------------------
function appHandler(server: BareWebServer, urlParts: url.UrlWithParsedQuery, req: http.IncomingMessage, resp: http.ServerResponse) {

  resp.on("error", (err) => { console.error(err) })

  //urlParts: the result of nodejs [url.parse] (http://nodejs.org/docs/latest/api/url.html)
  //urlParts.query: the result of nodejs [querystring.parse] (http://nodejs.org/api/querystring.html)

  try {
    if (urlParts.pathname === '/favicon.ico') {
      respond_error(404, "", resp)
    }
    else if (urlParts.pathname === '/') {
      //GET / (root) web server returns:
      server.writeFileContents("index-head.html", resp);
      resp.write(`
      <table>
      <tr><td>Start</td><td>${StarDateTime.toString()}</td></tr>    
      <tr><td>Total Polling Calls</td><td>${TotalPollingCalls}</td></tr>    
      <tr><td>Total Polling and not Validating</td><td>${TotalNotValidating}</td></tr>    
      <tr><td>Total Pings</td><td>${TotalPings}</td></tr>    
      <tr><td>Total Restarts</td><td>${TotalRestarts}</td></tr>    
      <tr><td>Total Restarts because time passed</td><td>${TotalRestartsBcTime}</td></tr>    
      <tr><td>Total Restarts because errors</td><td>${TotalRestartsBecauseErrors}</td></tr>    
      </table>
      `);
      resp.write("<br><hr><br>")
      readDatabase();
      resp.write("<pre>")
      resp.write(inspect(database,{ compact: true, depth: 5}));
      resp.write("</pre>")
      resp.write("<br><hr><br>")
      resp.write("<pre>")
      let tailText10 = spawnSync("tail", ["validator-health.log", "-n", "10"])
      resp.write(tailText10)
      resp.write("</pre>")
      resp.write("<br><hr><br>")
      resp.write("<pre>")
      let tailText = spawnSync("tail", ["validator-health.log", "-n", "400"])
      resp.write(tailText)
      resp.write("</pre>")
      resp.end()

      //   server.writeFileContents('index.html', resp);
      //   resp.end();
      //   return true;
    }

    else if (urlParts.pathname === '/restart') {
      let vindex = getVindexFromQuery(urlParts,resp);
      if (vindex) {
        restart(vindex,"user command /restart")
        resp.end("restaring " + vindex);
      }
    }
    else if (urlParts.pathname === '/ping') {
      let vindex = getVindexFromQuery(urlParts, resp);
      if (vindex) {
        ping(vindex)
        resp.end("PING " + vindex);
      }
    }
    else if (urlParts.pathname === '/ping') {
      resp.end("pong");
    }
    // else if (urlParts.pathname === '/shutdown') {
    //   process.exit(1);
    // }
    else {
      respond_error(500, 'invalid path ' + urlParts.pathname, resp);
    };
  }
  catch (ex) {
    try {
      respond_error(505, ex.message, resp)
    }
    catch { }
    console.log(ex)
  }
  return true;
};

class ErrData {
  public err: string = "";
  public data: any = null;
}



function saveDatabase() {
  fs.writeFileSync("database", JSON.stringify(database))
}
function readDatabase() {
  try {
    let buff = fs.readFileSync("database")
    database = JSON.parse(buff.toString())
  }
  catch (ex) {
    console.error(ex.message)
    database = { info: [] }
  }
}

function get_db_info(vindex: number) {
  let info = database.info[vindex]
  if (!info) {
    info = {
      lastPing: Date.now()-1*24*60*60*1000,
      lastRestart: Date.now(),
      lastBlock: 0,
      lastBlockDtm: 0,
    }
    database.info[vindex] = info
  }
  return info
}

//-------------------------------------------------
async function restart(vindex: number, reason:string) {
  console.log("RESTARTING", vindex, reason)
  spawnAsync("bash", ["restart.sh", vindex + ""])
  TotalRestarts++;
  const info = get_db_info(vindex)
  info.lastRestart = Date.now()
  saveDatabase()
}

//-------------------------------------------------
async function ping(vindex: number) {
  console.log("PING", vindex)
  //if resolved, remove pending from pending list in GATEWAY_CONTRACT_ID
  let result =  await near.call(sp_contract(vindex), "ping", {}, credentials.account_id, credentials.private_key, 100)
  console.log(result.status)
  TotalPings++;
  const info = get_db_info(vindex)
  info.lastPing = Date.now()
  saveDatabase()
}

//-------------------------------------------------
//check for pending requests in the SC and resolve them
//-------------------------------------------------
let seqId = 0;

function minutesSince(when: number): number {
  return Math.trunc((Date.now() - when) / 1000 / 60)
}
function hoursSince(when: number): number {
  return minutesSince(when)/60
}
function daysSince(when: number): number {
  return hoursSince(when)/24
}

async function checkHealth(vindex: number) {

  const container = "nearup" + vindex;
  const filter = "staking-pool-" + vindex;

  let logs:string;
  if (testMode) {
    logs = removeColors ( fs.readFileSync("log-example-"+vindex+".txt").toString() )
  }
  else {
    logs = spawnSync("bash", ["get-logs.sh", vindex + ""])
  }

  TotalPollingCalls++

  let isOk = true
  let isValidating = false
  let isDownloadingHeaders = false
  let lastBlock = 0;
  let lineCount = 0;
  let unkLines = 0;
  let maxCpu=0;
  let maxMem=0;
  let memUnits:string="";


  let errCount = 0

  let lines = logs.split('\n')
  for (let line of lines) {

    if (!line) continue;

    try {
      lineCount++;
      let words = line.split(' ')
      if (words[4] == "WARN") {
        //ignore;
      }
      else if (words[4] == "INFO") {
        if (words[6] && words[6].startsWith("#")) {
          lastBlock = parseInt(words[6].slice(1));
        }
        if (words[7] == "Downloading") {
          isDownloadingHeaders = true;
        }
        else if (words[8] && words[8].startsWith("V")) {
          isValidating = true;
        }
        if (words[20] && words[20].startsWith("CPU")) {
          const cpu=parseInt(words[21]);
          if (cpu>maxCpu) maxCpu=cpu;
        }
        if (words[22] && words[22].toUpperCase().startsWith("MEM")) {
          const mem=parseInt(words[23]);
          if (mem>maxMem) {
            maxMem=mem;
            memUnits = words[24];
          }
        }
      }
      else {
        unkLines++;
      }
    } catch (ex) {
      console.log(line)
      console.error(ex.message);
      isOk = false;
      errCount++;
      if (errCount > 5) break;
    }
  }

  if (lastBlock == 0) isOk = false;

  const info = get_db_info(vindex)
  const prevBlock = info.lastBlock
  const prevBlockDtm = info.lastBlockDtm

  if (lastBlock) {
    info.lastBlock = lastBlock
    info.lastBlockDtm = Date.now()
    saveDatabase()
  }

  //if block# does not advance
  if (prevBlock && lastBlock && prevBlock == lastBlock && prevBlockDtm && minutesSince(prevBlockDtm)>0.5) {
    console.error(`prevBlock:#${prevBlock} ${minutesSince(prevBlockDtm)} mins ago,  lastBlock:#${lastBlock} => block# NOT ADVANCING`)
    isOk = false;
  }

  console.log(vindex, new Date(), 
    `lastBlock:#${lastBlock} isOk:${isOk} isDownloadingHeaders:${isDownloadingHeaders} isValidating:${isValidating} lc:${lineCount} unkl:${unkLines} CPU:${maxCpu}% Mem:${maxMem}${memUnits}`)

  if (!isValidating) TotalNotValidating++

  if (!isOk && (!info.lastRestart || minutesSince(info.lastRestart) >= (isDownloadingHeaders?30:10) )) {
    //restart if it's not ok, and at least 10 mins passed since last restart 
    await restart(vindex, minutesSince(info.lastRestart) + " mins passed since last restart and it's not ok")
    TotalRestartsBecauseErrors++;
  }
  else if (!isValidating && info.lastRestart && daysSince(info.lastRestart) >= 5) { 
    //restart if 5 days passed since last restart and not validating rigth now (use the opportunity)
    await restart(vindex, daysSince(info.lastRestart) + " days passed since last restart and not validating rigth now (use the opportunity)")
    TotalRestartsBcTime++;
  }
  else if (isOk && (!info.lastPing || (info.lastPing && hoursSince(info.lastPing) >= 1.5))) {
    //ping if isOK, every 1.5 hs
    await ping(vindex) //ping every hour and a half
    TotalPings++;
  }

}


type ValidatorInfo = {
  lastRestart: number;
  lastPing: number;
  lastBlock: number;
  lastBlockDtm: number;
}
type Database = {
  info: ValidatorInfo[];
}
let database: Database;

readDatabase()

//read config
let config={from:2, to:3}
try {
  let buff = fs.readFileSync("../config.json")
  config = JSON.parse(buff.toString())
}
catch (ex) {
  console.error("Err reading '../config.json'",ex.message)
  console.error('expected contents: {"from":3, "to":4}')
  process.exit(1)
}

//-----------
// Log start
//-----------
console.log(process.cwd())
console.error("err output test")
//----------------------
// Get signing credentials
//-----------------------
let credentialsString = fs.readFileSync(CREDENTIALS_FILE).toString();
let credentials = JSON.parse(credentialsString)

// -----------
//Start Server
//------------
//We start a barebones minimal web server 
//When a request arrives, it will call appHandler(urlParts, request, response)
const server = new BareWebServer('../public_html', appHandler, 7000)

server.start()

//check for pending requests in the SC and resolve them
pollingLoop();

//-----------------
//Loops checking for validator health every 5 mins
//-----------------
let loopsExecuted=0;
async function pollingLoop() {
  //loop checking preiodically if there are pending requests
  try {
    for (let vindex=config.from; vindex<=config.to; vindex++){
      await checkHealth(vindex);
    }
  }
  catch (ex) {
    console.error("ERR", ex.message)
  }

  loopsExecuted++;
  if (loopsExecuted>=20 || (testMode && loopsExecuted>=5)) {
    //cycle finished- gracefully end process, pm2 will restart it
    server.close()
    return;
  }
  else {
    //check again in 5 minutes (test-mode every 10 secs)
    const seconds = testMode? 10 : 5*60
    setTimeout(pollingLoop, seconds * 1000)
  }
}

