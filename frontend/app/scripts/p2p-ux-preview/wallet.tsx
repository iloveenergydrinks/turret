export function WalletSessionProvider({children}: {children: import("react").ReactNode}){return children;}
export function useWalletSession(){return {account:null,chainId:null,provider:null,connecting:false,error:null,connect:async()=>{alert('Local preview only. No wallet transactions are sent.');},disconnect:()=>{}};}
export function AccountButton(){return <button className="dockyard-wallet-button" onClick={()=>alert('Local preview only. No wallet transactions are sent.')}>Connect wallet</button>;}
