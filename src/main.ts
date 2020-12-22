import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as url from 'url';

import { BareWebServer, respond_error } from './bare-web-server.js';
import * as near from './near-api/near-rpc.js';
import * as network from './near-api/network.js';
import { spawnSync, spawnAsync } from './util/spawn.js';

const NETWORK = "guildnet"
network.setCurrent(NETWORK)
const CREDENTIALS_FILE = `../../../.near-credentials/${NETWORK}/luciotato.${NETWORK}.json`

const StarDateTime = new Date()
let TotalPollingCalls = 0
let TotalNotValidating = 0
let TotalRestarts = 0
let TotalRestartsBcTime = 0
let TotalRestartsBecauseErrors = 0

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
      <tr><td>Total Restarts</td><td>${TotalRestarts}</td></tr>    
      <tr><td>Total Restarts because time passed</td><td>${TotalRestartsBcTime}</td></tr>    
      <tr><td>Total Restarts because errors</td><td>${TotalRestartsBecauseErrors}</td></tr>    
      </table>
      `);
      resp.write("<br><hr><br>")
      resp.write("<pre>")
      let tailText = spawnSync("tail", ["validator-health.log", "-n", "800"])
      resp.write(tailText)
      resp.end("</pre>")

      //   server.writeFileContents('index.html', resp);
      //   resp.end();
      //   return true;
    }

    else if (urlParts.pathname === '/restart') {
      if (typeof urlParts.query["q"] != "string") {
        resp.end("query must be 2-4 and received:" + JSON.stringify(urlParts.query) + (typeof urlParts.query));
      }
      else {
        let vindex = parseInt(urlParts.query["q"]);
        if (isNaN(vindex) || vindex < 2 || vindex > 4) {
          resp.end("vindex must be 2-4 and received:" + urlParts.query);
        }
        else {
          restart(vindex)
          resp.end("restaring " + vindex);
        }
      }
    }
    else if (urlParts.pathname === '/stats') {
      resp.end("none");
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

//struct returned from get_account_info
export type PendingRequest = {
  //the requesting contract
  contract_account_id: string;
  /// A request-id internal to requesting contract
  request_id: string; //U128,
  /// DIA API Key
  data_key: string;
  ///DIA API Item
  data_item: string;
  /// cablack method to invoke with the data
  callback: string;
}

class ErrData {
  public err: string = "";
  public data: any = null;
}

//------------------------------
//--  fetch api.diadata.org
//------------------------------
async function fetchDiaJson(endpointPlusParam: string): Promise<ErrData> {

  let response: ErrData;

  const fullEndpoint = "https://api.diadata.org/v1/" + endpointPlusParam
  const fetchResult = await fetch(fullEndpoint)
  let errGetJson: string = "";
  let jsonData;
  try {
    jsonData = await fetchResult.json()
  }
  catch (ex) {
    errGetJson = ex.message;
    jsonData = undefined;
  }

  if (!fetchResult.ok) throw Error(fullEndpoint + " " + fetchResult.status + " " + fetchResult.statusText)
  if (!jsonData) throw Error(fullEndpoint + " ERR:EMPTY RESPONSE " + errGetJson)
  if (jsonData.errorcode) { //some error reported by the diadata server. e.g. unexistent coin
    throw Error(fullEndpoint + JSON.stringify(jsonData))
  }

  response = new ErrData()
  response.data = jsonData;
  return response
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
      lastRestart: Date.now(),
      lastBlock: 0,
    }
    database.info[vindex] = info
  }
  return info
}

function restart(vindex: number) {
  console.log("RESTARTING", vindex)
  spawnAsync("bash", ["restart.sh", vindex + ""])
  TotalRestarts++;
  const info = get_db_info(vindex)
  info.lastRestart = Date.now()
  saveDatabase()
}

//-------------------------------------------------
//check for pending requests in the SC and resolve them
//-------------------------------------------------
let seqId = 0;

function hoursSince(when: number): number {
  return (Date.now() - when) / (1000 * 60 * 60)
}

async function checkHealth(vindex: number) {

  const container = "nearup" + vindex;
  const account = "staking-pool-" + vindex;

  let logs = spawnSync("bash", ["get-logs.sh", vindex + ""])

  TotalPollingCalls++

  let isOk = true
  let isValidating = false
  let lastBlock = 0;
  let lineCount =0;
  let unkLines =0;

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
        if (words[6].startsWith("#")) {
          lastBlock = parseInt(words[6].slice(1));
        }
        if (words[8].startsWith("V")) {
          isValidating = true;
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

  if (lastBlock==0) isOk=false;

  console.log(new Date(), vindex, "lastBlock", lastBlock, " isOk:", isOk, "isV:", isValidating, "lineCount",lineCount,"unkLines:",unkLines)

  const info = get_db_info(vindex)
  const prevBlock = info.lastBlock

  if (lastBlock) {
    info.lastBlock = lastBlock
    saveDatabase()
  }

  if (!isValidating) TotalNotValidating++

  //if block# does not advance
  if (prevBlock && lastBlock && prevBlock == lastBlock) {
    console.error("block# NOT ADVANCING")
    isOk = false;
  }

  if (!isOk) {
    restart(vindex)
    TotalRestartsBecauseErrors++;
  }
  else if (info.lastRestart) {
    if (hoursSince(info.lastRestart) >= 48) {
      restart(vindex)
      TotalRestartsBcTime++;
    }
    else if (!isValidating && hoursSince(info.lastRestart) >= 2) {
      restart(vindex)
      TotalRestartsBcTime++;
    }
  }

}

//-----------------
//Loops checking for pending requests in the SC and resolving them every 10 seconds
//-----------------
async function pollingLoop() {
  //loop checking preiodically if there are pending requests
  try {
    await checkHealth(vindex);
  }
  catch (ex) {
    console.error("ERR", ex.message)
  }
  vindex++;
  if (vindex > 4) vindex = 2;
  //check again in 3 minutes
  setTimeout(pollingLoop, 3 * 60 * 1000)
  //test-mode every 10 secs: setTimeout(pollingLoop, 10 * 1000)
}


type ValidatorInfo = {
  lastRestart: number;
  lastBlock: number;
}
type Database = {
  info: ValidatorInfo[];
}
let database: Database;
let vindex = 2;

readDatabase()

//----------------------
// Get signing credentials
//-----------------------
console.log(process.cwd())
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
