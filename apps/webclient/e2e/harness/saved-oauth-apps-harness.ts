/** Local metadata/consent fixture. No real account or provider request. */
import { OPENER_RELAY_MESSAGE_KIND,type OAuthAppConfigSnapshot,type ConnectionView } from '@recued/contracts';
import { CONNECTIONS_PAGE_STYLES } from '@recued/ui-shared';
import { mountConnectionsEnrollPanel,type VendorOAuthPopupHandle } from '../../src/settings/connections-enroll-panel.js';
const root=document.querySelector<HTMLElement>('#root')!;
const style=document.createElement('style');style.textContent=CONNECTIONS_PAGE_STYLES;document.head.appendChild(style);
const cloud=new URLSearchParams(location.search).has('cloud');
const calls:Array<{method:string;args:unknown}>=[];const record=(method:string,args:unknown)=>calls.push({method,args:structuredClone(args)});
let config:OAuthAppConfigSnapshot={google:{client_id:'saved-google-id',has_secret:true,source:'stored'},microsoft:{client_id:'saved-microsoft-id',has_secret:true,source:'stored'}};
let fail=false;let rows:ConnectionView[]=[];
let popup:VendorOAuthPopupHandle&{closed:boolean;close():void}={location:{href:''},closed:false,close(){this.closed=true;},sessionStorage:{setItem(){}}};
let receive:((event:{origin:string;data:unknown})=>void)|undefined;
let completed:((event:{flow_id:string})=>void)|undefined;
const panel=mountConnectionsEnrollPanel({host:root,document,initialVendor:'google',
 runList:async()=>({connections:rows}),runUpdate:async()=>{throw new Error('unused');},runDelete:async()=>({deleted:true}),runProbe:async()=>({health:{status:'ok',checked_at:1}}),
 runGetOAuthAppConfig:async()=>{record('server.getOAuthAppConfig',{});if(fail)throw new Error('fixture outage');return structuredClone(config);},
 runEnroll:async args=>{record('collection.connection.enroll',args);const app=args.oauth_app_issuer;
   if(app&&args.auth.type==='oauth2_refresh'&&args.auth.client_id!==config[app].client_id)throw new Error('The saved OAuth app changed. Refresh and authorize again.');
   const connection:ConnectionView={name:args.name,kind:args.kind,display_name:args.display_name,auth_type:args.auth.type,...args.config};rows=[connection];return{connection};},
 runStartVendorOAuth:async args=>{record('collection.connection.startVendorOAuth',args);return{authorize_url:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture-state',flow_id:'saved-app-flow',server_identity_public_key_b64:'fixture-public-key',claim_secret:'fixture-owner-claim'};},
 runTakeVendorOAuthResult:async args=>{record('collection.connection.takeVendorOAuthResult',args);return{result:{refresh_token:'fixture-own-refresh',granted_scopes:['drive.readonly']}};},
 runCompleteVendorOAuth:async args=>{record('collection.connection.completeVendorOAuth',args);return{refresh_token:'fixture-own-refresh',granted_scopes:['drive.readonly']};},
 subscribe:((_kind:string,fn:(event:{flow_id:string})=>void)=>{completed=fn;return()=>{completed=undefined;};}) as Parameters<typeof mountConnectionsEnrollPanel>[0]['subscribe'],
 oauthEnv:{open:()=>{popup={location:{href:''},closed:false,close(){this.closed=true;},sessionStorage:{setItem(){}}};return popup;},setTimeout:()=>1,clearTimeout:()=>{}},
 foundationalOAuthEnv:{origin:cloud?'https://app.recued.com':location.origin,randomState:()=>crypto.randomUUID(),onMessage:fn=>{receive=fn;return()=>{receive=undefined;};},setTimeout:()=>()=>{},setInterval:()=>()=>{}},
});
const api={calls,popupUrl:()=>popup.location.href,state:()=>panel.getState(),
 finish:()=>{if(cloud){completed?.({flow_id:'saved-app-flow'});return;}
   receive?.({origin:location.origin,data:{kind:OPENER_RELAY_MESSAGE_KIND,state:new URL(popup.location.href).searchParams.get('state'),code:'fixture-local-code'}});},
 wrongRelay:()=>receive?.({origin:'https://wrong.example.test',data:{kind:OPENER_RELAY_MESSAGE_KIND,state:'wrong-state',code:'wrong-code'}}),
 remove:()=>{config={...config,google:{client_id:null,has_secret:false,source:null}};},
 change:()=>{config={...config,google:{client_id:'new-google-id',has_secret:true,source:'stored'}};},
 fail:()=>{fail=true;},recover:()=>{fail=false;},dispose:()=>panel.dispose(),refresh:()=>panel.refresh()};
Object.assign(window,{__savedApps:api});
declare global{interface Window{__savedApps:typeof api}}
