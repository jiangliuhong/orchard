import type {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {declarations,sql} from './frozen.js';
import {captureRows,verifyMapping} from './mapping.js';
import {verifyDatabase} from './validators.js';
import {safe,writeJson} from './journal.js';
import {migrateBridgeConfigV0,validateBridgeConfigV1} from './config.js';
import {MigrationError,type MigrationDeclaration,type Step} from './types.js';
export interface MigrationContext {database:DatabaseSync;root:string;sourceRoot:string;answers:Readonly<Record<string,unknown>>}
export interface MigrationDefinition extends MigrationDeclaration {run(context:MigrationContext):void;validate(context:MigrationContext):void}
export function definitions():MigrationDefinition[]{return declarations.map(declaration=>{
 let before:ReturnType<typeof captureRows>|undefined;
 return {...declaration,
  run(context){
   if(declaration.kind==='database'){
    if(verifyDatabase(context.database,context.root,context.sourceRoot)!==declaration.from||!sql[declaration.from])throw new MigrationError('CHAIN_UNSUPPORTED');
    before=captureRows(context.database);context.database.exec(sql[declaration.from]);
   }else if(declaration.id==='config.web-bridge.v0-v1'){
    const path=safe(context.root,'config/web-bridge.json');writeJson(path,migrateBridgeConfigV0(readFileSync(path,'utf8')));
   }else throw new MigrationError('CHAIN_UNSUPPORTED');
  },
  validate(context){
   if(declaration.kind==='database'){
    if(!before||verifyDatabase(context.database,context.root,context.sourceRoot)!==declaration.to)throw new MigrationError('DATABASE_CORRUPT');
    verifyMapping(context.database,before,declaration.from,declaration.to);
   }else validateBridgeConfigV1(readFileSync(safe(context.root,'config/web-bridge.json'),'utf8'));
  },
 };
});}
export function applyDefinitions(context:MigrationContext,steps:Step[],after:(step:Step)=>void=()=>{}){
 const registered=definitions();
 for(const step of steps){const definition=registered.find(value=>value.id===step.id&&value.checksum===step.checksum);if(!definition)throw new MigrationError('CHAIN_UNSUPPORTED');definition.run(context);definition.validate(context);after(step);}
}
