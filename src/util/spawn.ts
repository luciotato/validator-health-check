/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as child_process from "child_process"

let debug = 0
export function setDebug(value: 0 | 1 | 2):void { debug = value }

export function decodeHTMLEntities(str:string):string {
    str = str.replace(/&#(\d+);/g, function(match, dec) {
        return String.fromCharCode(dec)
    })
    str = str.replace(/&#(x[A-F0-9]+);/g, function(match, dec) {
        return String.fromCharCode(parseInt("0" + dec))
    })
    return str.replace(/&quot;/g, "'")
}

export function removeColors(str:string){
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "")
    
}

export function yton(yoctos:string):string {
    let units = yoctos
    if (units.length < 25) units = units.padStart(25, '0')
    units = units.slice(0, -24) + "." + units.slice(-24)
    return units
}

export function spawnSync(command:string, args:(string|any)[]):string {
    
    console.log("spawnSync:",command,args.join(" "))
    const execResult = child_process.spawnSync(command, args, { shell: true }) // shell:true => to be able to invoke near-cli on windows

    // console.log(execResult.stdout.toString())
    // console.log(execResult.stderr.toString())

    if (execResult.error) {
        console.log(execResult.error)
        throw Error(execResult.error.toString())
    }
    let stdo = ""
    if (execResult.stdout) {
        // // console.log("stdout:")
        // // console.log("-*-")
        // // fixes for  near-cli output
        // stdo = decodeHTMLEntities(execResult.stdout.toString())
        // process.stdout.write(stdo)
        // // console.log("-*-")
        stdo = execResult.stdout.toString()
    }
    if (execResult.stderr && execResult.stderr.length>0) {
        // // console.log("stderr:")
        // // console.log("-*-")
        // process.stdout.write(decodeHTMLEntities(execResult.stderr.toString()))
        // // console.log("-*-")
        throw Error(execResult.stderr.toString())
    }

    if (execResult.status != 0) {
        throw Error("exit status "+execResult.status)
    }

    return removeColors(stdo)
}

export function spawnAsync(command:string, args:(string|any)[]):void {
    console.log("spawnAsync:",command,args.join(" "))
    const ls = child_process.spawn( command, args );
    ls.stdout.on( 'data', data => {
        console.log( `stdout: ${data}` );
    } );
    ls.stderr.on( 'data', data => {
        console.log( `stderr: ${data}` );
    } );
    ls.on( 'close', code => {
        console.log( `child process exited with code ${code}` );
    } );
}
