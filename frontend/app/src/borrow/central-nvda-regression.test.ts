import{test,expect}from'vitest';import{centralStatus}from'./central-credit';
const fixture={"market": "NVDA", "policyHash": "0x24e7841a87d7e3cbb96327cd222d156df27f3e1dd2661c3fa2a416c80c45cc10", "ready": false, "code": "CorporateActionPending", "qualification": {"at": 1789040111, "key": "0x24e7841a87d7e3cbb96327cd222d156df27f3e1dd2661c3fa2a416c80c45cc10", "code": "CorporateActionPending", "kind": "hard", "ready": false, "samples": 0, "healthySeconds": 0, "consecutiveSince": 1789040111, "interruptedSeconds": 0}, "prices": null};
test('the actual NVDA pending response remains an explicit rejection with no borrow capacity',async()=>{
 const m={id:'NVDA',apiUrl:'https://turret-central-risk-production.up.railway.app/',policyHash:fixture.policyHash as `0x${string}`,weekend:false};
 const result=await centralStatus(m,async()=>new Response(JSON.stringify(fixture)),()=>fixture.qualification.at*1000+1000);
 expect(result.code).toBe('CorporateActionPending');expect(result.price).toBeNull();expect(result.borrowingPrice).toBeNull();expect(result.ready).toBe(false);
});
