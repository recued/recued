/** Fail an acknowledged batch partway through without bypassing RPC recording. */
export const installReceptionWizardFixture = () => {
  const view=window as any,original=view.__receptionFixture,params=new URLSearchParams(location.search);
  const state=view.__wizardFixture={createAttempts:0,failCreateAt:Number(params.get('wizard_fail_create_at')??0),failed:false};
  view.__receptionFixture=async(method:string,args:unknown)=>{
    const fail=method==='reception.endpoint.create'&&++state.createAttempts===state.failCreateAt&&!state.failed;
    if(fail){state.failed=true;view.__endpoints.failing.push(method);}
    try{return await original(method,args);}
    finally{if(fail)view.__endpoints.failing=view.__endpoints.failing.filter((m:string)=>m!==method);}
  };
};
