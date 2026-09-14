const integer=(value,size,signed=false)=>{
  const bytes=Buffer.alloc(size);
  if(size===8) signed?bytes.writeBigInt64BE(value):bytes.writeBigUInt64BE(value);
  else if(size===4)bytes.writeUInt32BE(value);
  else if(size===2)signed?bytes.writeInt16BE(value):bytes.writeUInt16BE(value);
  else bytes[0]=value;
  return bytes;
};
export function payload(values) {
  return Buffer.concat([integer(2479346549,4),integer(values[0].timestampUs,8),Buffer.from([1,values.length]),
    ...values.map(f=>Buffer.concat([integer(f.id,4),Buffer.from([6,0]),integer(f.price,8,true),
      Buffer.from([3]),integer(f.publishers,2),Buffer.from([4]),integer(f.exponent,2,true),
      Buffer.from([5]),integer(f.confidence,8),Buffer.from([9]),integer(f.session,2),
      Buffer.from([12,1]),integer(f.sourceUs,8)]))]);
}
export function wrapPayload(data,signature=Buffer.alloc(65)) {
  return '0x'+Buffer.concat([integer(706910618,4),signature,integer(data.length,2),data]).toString('hex');
}
// Without a signature, this is a transport fixture only, not an authenticated report.
export const envelope=values=>wrapPayload(payload(values));
