import type { ReceptionIntakeRecipePairView, ServerRecipeListEntry } from '@recued/contracts';

/** The real owner page, with exact pair observations and controllable transport. */
export const installReceptionPairingFixture = () => {
  const view = window as any;
  const original = view.__receptionFixture;
  const params = new URLSearchParams(location.search);
  const endpoint_id = 'customer-intake';
  const configuration = { version: 1 as const, stripe_connection_name: 'stripe-primary', success_url: 'https://studio.example.test/checkout/success', cancel_url: 'https://studio.example.test/checkout/cancel', expiry_window_ms: 1_800_000, template_file_ref: `file:${'c'.repeat(32)}` };
  const ready = (recipe_id='project-checkout',clock=101): ReceptionIntakeRecipePairView => ({
    endpoint_id,status:'ready',pair_subject:'form',binding:{version:1,recipe_id,recipe_version:3,form_definition_id:'customer-project',pair_revision:`d200-pair-v1-${'a'.repeat(64)}`},
    claim_configuration_readiness:{status:'ready',configuration,blockers:[]},claim_configuration_authoring:{status:'editable'},created_at:100,updated_at:clock,
  });
  const unpaired = (): ReceptionIntakeRecipePairView => ({endpoint_id,status:'unpaired',binding:null,created_at:null,updated_at:null});
  const recipe = (recipe_id:string,name:string): ServerRecipeListEntry => ({recipe_id,publisher_id:'local-owner',version:3,recipe_hash:'fixture-hash',source:'pair-sync',installed_at:50,
    recipe:{recipe_id,version:3,ttl:300,metadata:{name,description:'An exact owner-reviewed local recipe.',author:'local-owner',supported_platforms:[]},variables:{},output:{render:[]}}});
  const state: {pair:ReceptionIntakeRecipePairView;recipes:ServerRecipeListEntry[];consent:boolean;refuse:boolean} = view.__pairing = {pair: params.has('pair_unpaired') ? unpaired() : ready(), recipes: params.has('pair_empty') ? [] : [recipe('project-checkout','Prepare a project checkout and send the reviewed customer documents'),recipe('project-followup','Follow up on a customer project')], consent:params.has('pair_consent'),refuse:params.has('pair_refused')};
  if(params.has('pair_stale')) state.pair=params.has('pair_corrupt')?{endpoint_id,status:'stale',binding:null,created_at:null,updated_at:null}:{endpoint_id,status:'stale',binding:ready().binding!,created_at:100,updated_at:101};
  if(params.has('pair_fork') && state.pair.status==='ready' && state.pair.pair_subject==='form') state.pair={...state.pair,claim_configuration_authoring:{status:'fork_required'}};
  if(params.has('pair_blocked') && state.pair.status==='ready' && state.pair.pair_subject==='form') state.pair={...state.pair,claim_configuration_readiness:{status:'blocked',configuration:null,blockers:['claim_configuration_missing','stripe_connection_missing','template_missing']}};
  view.__receptionFixture = async(method:string,raw:unknown) => {
    const prior=await original(method,raw);if(prior) return prior;
    const args=raw as Record<string,any>;
    if(method==='recipe.list')return {result:{recipes:structuredClone(state.recipes)}};
    if(method==='reception.intake_recipe_pair.get')return {result:structuredClone(state.pair)};
    if(method==='reception.intake_recipe_pair.bind') {
      state.pair=ready(args.recipe_id,(state.pair.updated_at??100)+1);
      return {result:{outcome:'updated',pair:structuredClone(state.pair),door:state.refuse?{status:'refused',reason:'dynamic_dispatch',step_id:'dispatch',detail:'The recipe chooses its operation dynamically.'}:state.consent&&!args.confirm_capability?{status:'needs_consent',added:['work.create:task','mail.send'],removed:[],operation_ids:['work.create:task','mail.send']}:{status:'bound',contract_id:'door-fixture',operation_ids:['work.create:task','mail.send'],unchanged:false}}};
    }
    if(method==='reception.intake_recipe_pair.configure'){
      if(!state.pair.binding)return{error:{code:'bad_request',message:'No ready pair'}};Object.assign(configuration,args.configuration);state.pair={endpoint_id,status:'stale',binding:state.pair.binding,created_at:100,updated_at:102};
      return{result:{outcome:'updated',recipe_id:'project-checkout',pair_requires_rebind:true}};
    }
    if(method==='reception.intake_recipe_pair.clear'){state.pair=unpaired();return{result:{removed:true}};}
    return undefined;
  };
};
