import { createContext, useContext } from 'react';
export const TestWalletContext = createContext<any>(null);
export const useWalletSession = () => useContext(TestWalletContext);
