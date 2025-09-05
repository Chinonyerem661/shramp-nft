import { useEffect, useState, useCallback } from "react";
import { BrowserProvider, Contract } from "ethers";
import type { Provider, Signer } from "ethers";
import contractABI from "./contractABI";
import bg from "./assets/monad-bg-3.jpeg";

const CONTRACT_ADDRESS =
  import.meta.env.VITE_CONTRACT_ADDRESS ||
  "0x550EE8dc2d0c581EaBd58bA4976e47DD028a989B";

// Removed mock images; rely on real on-chain data

interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (accounts: string[]) => void) => void;
  removeListener?: (event: string, handler: () => void) => void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export default function App() {
  const [account, setAccount] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [totalSupply, setTotalSupply] = useState<number>(0);
  const [maxSupply, setMaxSupply] = useState<number>(500);
  const [mintPriceWei, setMintPriceWei] = useState<string>("0"); // hex or string
  const [status, setStatus] = useState<string>("");
  const [mintQuantity, setMintQuantity] = useState<number>(1);
  const [userMintedCount, setUserMintedCount] = useState<number>(0);
  const [contractMaxPerWallet, setContractMaxPerWallet] = useState<number>(2);

  function getContract(providerOrSigner: Provider | Signer) {
    return new Contract(CONTRACT_ADDRESS, contractABI, providerOrSigner);
  }

  const refreshContractData = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      const provider = new BrowserProvider(window.ethereum);
      const contract = getContract(provider);
      const supply = await contract.totalSupply();
      const max = await contract.maxSupply();
      const price = await contract.mintPrice();
      const maxPerWallet = await contract.maxPerWallet();

      setTotalSupply(Number(supply));
      // Clamp to 500 for UI display even if contract is higher
      setMaxSupply(Math.min(Number(max), 500));
      // price is BigInt in ethers v6, convert to string (wei)
      setMintPriceWei(price.toString());
      setContractMaxPerWallet(Number(maxPerWallet));

      console.log(
        "Contract values - maxPerWallet:",
        Number(maxPerWallet),
        "maxSupply:",
        Number(max)
      );

      // Get user's minted count if wallet is connected
      if (account) {
        const minted = await contract.mintedCount(account);
        console.log("User minted count from contract:", Number(minted));
        setUserMintedCount(Number(minted));
      }
    } catch (e) {
      console.error("refreshContractData err", e);
    }
  }, [account]);

  async function connectWallet() {
    if (!window.ethereum) return alert("Install MetaMask");
    try {
      const provider = new BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      setAccount(accounts[0]);
      setStatus("Wallet connected");
      await refreshContractData();
    } catch (e) {
      console.error(e);
      setStatus("Failed to connect wallet");
    }
  }

  async function mintNFT() {
    if (!window.ethereum) return alert("Install MetaMask");
    if (mintQuantity < 1 || mintQuantity > 2)
      return alert("Quantity must be 1-2");

    // Check wallet restrictions
    console.log(
      "Mint attempt - userMintedCount:",
      userMintedCount,
      "mintQuantity:",
      mintQuantity,
      "contractMaxPerWallet:",
      contractMaxPerWallet
    );

    if (userMintedCount + mintQuantity > 2) {
      return alert(
        `You can only mint ${2 - userMintedCount} more NFT${
          2 - userMintedCount === 1 ? "" : "s"
        }. You've already minted ${userMintedCount}.`
      );
    }

    setMinting(true);
    setStatus("Preparing transaction...");
    try {
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const contract = getContract(signer);
      const price = await contract.mintPrice(); // BigInt
      const totalPrice = price * BigInt(mintQuantity);
      // call mint with quantity and value for multiple NFTs
      const tx = await contract.mint(mintQuantity, { value: totalPrice });
      setStatus("Waiting for confirmation...");
      await tx.wait();
      setStatus(`Minted ${mintQuantity} NFT${mintQuantity > 1 ? "s" : ""}!`);
      // refresh supply
      await refreshContractData();
    } catch (e) {
      console.error(e);
      const error = e as Error;
      setStatus(error?.message || "Mint failed");
    } finally {
      setMinting(false);
    }
  }

  // If needed, fetch tokenURI and render real previews later

  useEffect(() => {
    // refresh contract data on load
    refreshContractData();
    // optional: listen for accounts change
    if (window.ethereum) {
      window.ethereum.on?.("accountsChanged", (accounts: string[]) => {
        setAccount(accounts[0] || null);
      });
    }
    // cleanup
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", () => {});
    };
  }, [refreshContractData]);

  // convert wei to readable MON
  function formatMon(weiStr: string) {
    try {
      // weiStr is decimal string (BigInt as string)
      // convert to number of MON with 18 decimals (avoid precision issues for display)
      const bn = BigInt(weiStr);
      const whole = bn / BigInt(1e18);
      const frac = bn % BigInt(1e18);
      const fracStr = String(frac).padStart(18, "0").slice(0, 4); // 4 decimals
      return `${whole.toString()}.${fracStr}`;
    } catch {
      return "0";
    }
  }

  const progressPercent = Math.min(
    100,
    Math.round((totalSupply / maxSupply) * 100)
  );

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-start text-white px-3 sm:px-4"
      style={{
        backgroundImage: `url("${bg}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="w-full max-w-4xl px-4 py-6 md:p-8 bg-black/60 backdrop-blur-sm mt-6 md:mt-12 rounded-lg md:rounded-xl">
        <h1 className="text-3xl md:text-4xl font-bold mb-2">Shramp NFT</h1>
        <p className="text-xs md:text-sm text-gray-300 mb-4">
          Public mint ⭐ max 2 per wallet ⭐
        </p>

        <div className="mb-4">
          <div className="w-full bg-gray-700 rounded-full h-3 md:h-4 overflow-hidden">
            <div
              className="h-3 md:h-4 bg-green-400"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex justify-between text-xs md:text-sm mt-2">
            <span>{totalSupply} minted</span>
            <span>{maxSupply} max</span>
          </div>
        </div>

        {account && (
          <div className="mb-4">
            <label className="block text-xs md:text-sm text-gray-300 mb-2">
              Quantity (1-2):
            </label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMintQuantity(Math.max(1, mintQuantity - 1))}
                disabled={mintQuantity <= 1}
                className="px-3 py-1 bg-gray-600 rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                -
              </button>
              <input
                type="number"
                min="1"
                max={Math.min(2, 2 - userMintedCount)}
                value={mintQuantity}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 1;
                  const maxAllowed = Math.min(2, 2 - userMintedCount);
                  setMintQuantity(Math.min(maxAllowed, Math.max(1, val)));
                }}
                className="w-16 px-2 py-1 bg-gray-700 text-white rounded text-center"
              />
              <button
                onClick={() =>
                  setMintQuantity(
                    Math.min(2, Math.min(2 - userMintedCount, mintQuantity + 1))
                  )
                }
                disabled={mintQuantity >= Math.min(2, 2 - userMintedCount)}
                className="px-3 py-1 bg-gray-600 rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                +
              </button>
            </div>
            <div className="text-xs text-gray-400 mt-1">
              You've minted: {userMintedCount}/2 NFTs
              {userMintedCount >= 2 && (
                <span className="text-red-400 ml-2">(Max reached!)</span>
              )}
            </div>
          </div>
        )}

        <div className="flex gap-3 md:gap-4 items-stretch sm:items-center mb-6 flex-col sm:flex-row">
          {!account ? (
            <button
              onClick={connectWallet}
              className="px-5 py-2 bg-purple-600 rounded hover:bg-purple-700 w-full sm:w-auto"
            >
              Connect Wallet
            </button>
          ) : (
            <div className="flex items-stretch sm:items-center gap-3 md:gap-4 flex-col sm:flex-row w-full">
              <div className="text-xs md:text-sm">
                Connected: {account.slice(0, 6)}...{account.slice(-4)}
              </div>
              <button
                onClick={mintNFT}
                disabled={minting || userMintedCount >= 2}
                className={`px-5 py-2 rounded w-full sm:w-auto ${
                  minting || userMintedCount >= 2
                    ? "bg-gray-600 cursor-not-allowed"
                    : "bg-green-500 hover:bg-green-600"
                }`}
              >
                {minting
                  ? "Minting..."
                  : userMintedCount >= 2
                  ? "Max NFTs Minted"
                  : `Mint ${mintQuantity} (${formatMon(
                      (BigInt(mintPriceWei) * BigInt(mintQuantity)).toString()
                    )} MON)`}
              </button>
            </div>
          )}
          <div className="text-xs md:text-sm text-gray-300 ml-0 sm:ml-auto w-full sm:w-auto">
            {status}
          </div>
        </div>

        {/* Preview grid removed; wallet/marketplaces will display images from tokenURI */}
      </div>
    </div>
  );
}
