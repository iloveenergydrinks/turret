export function acceptSharedTransportVerification(store,value,configured,now=Date.now()) {
  if(!configured||!/^[0-9]{13}$/.test(value??''))return false;
  const at=Number(value);
  if(!Number.isSafeInteger(at)||at>now+30_000||now-at>60*60_000)return false;
  store.set('transportVerified',true);
  store.set('transportPreverifiedAt',at);
  return true;
}
