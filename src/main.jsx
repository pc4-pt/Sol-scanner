import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";
import App from "./App.jsx";
import { ErrorBoundary } from "./ErrorBoundary.jsx";

// Wallet adapter CSS override — match our dark theme
const walletStyles = `
  .wallet-adapter-modal-wrapper {
    background: #13171f !important;
    border: 1px solid #1f2937 !important;
    border-radius: 12px !important;
  }
  .wallet-adapter-modal-title { color: #e2e8f0 !important; }
  .wallet-adapter-button {
    background: #161b24 !important;
    border: 1px solid #1f2937 !important;
    color: #94a3b8 !important;
    font-family: 'IBM Plex Mono', monospace !important;
    font-size: 0.78rem !important;
    border-radius: 6px !important;
  }
  .wallet-adapter-button:hover { background: #1b2130 !important; border-color: #00e5c3 !important; }
  .wallet-adapter-modal-list-more { color: #475569 !important; }
  .wallet-adapter-modal-overlay { background: rgba(0,0,0,0.75) !important; }
`;

function Root() {
 const endpoint = import.meta.env.VITE_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
  const wallets  = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <style>{walletStyles}</style>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode><Root /></StrictMode>
);
