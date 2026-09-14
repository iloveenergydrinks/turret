const response=await fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/status`,{
  headers:{Authorization:`Bearer ${process.env.KEEPER_STATUS_TOKEN}`},signal:AbortSignal.timeout(10000),
});
if (!response.ok) {console.error('Keeper status unavailable');process.exitCode=1;}
else console.log(JSON.stringify(await response.json(),null,2));
