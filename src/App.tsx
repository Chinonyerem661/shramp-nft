import { useEffect, useState, useCallback } from "react";
import { BrowserProvider, Contract } from "ethers";
import type { Provider, Signer } from "ethers";
import contractABI from "./contractABI";
import bg from "./assets/monad-bg-3.jpeg";

const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS as
  | string
  | undefined;

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
  const isConfigured = Boolean(CONTRACT_ADDRESS);
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
    if (!CONTRACT_ADDRESS) {
      throw new Error(
        "VITE_CONTRACT_ADDRESS is not set. Configure it in your Vercel env."
      );
    }
    return new Contract(
      CONTRACT_ADDRESS as string,
      contractABI,
      providerOrSigner
    );
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
        try {
          const minted = await contract.mintedCount(account);
          console.log("User minted count from contract:", Number(minted));
          setUserMintedCount(Number(minted));
        } catch (mcErr) {
          // Fallback to ERC721 balance if mintedCount() is not present
          try {
            const bal = await contract.balanceOf(account);
            console.log("Fallback balanceOf as minted count:", Number(bal));
            setUserMintedCount(Number(bal));
          } catch (balErr) {
            console.warn("Failed to read user minted count", mcErr, balErr);
            setUserMintedCount(0);
          }
        }
      }
    } catch (e) {
      console.error("refreshContractData err", e);
    }
  }, [account]);

  async function ensureMonadNetwork(provider: BrowserProvider) {
    const targetChainIdHex = "0x279F"; // 10143
    try {
      const current = await provider.send("eth_chainId", []);
      if (current !== targetChainIdHex) {
        try {
          await provider.send("wallet_switchEthereumChain", [
            { chainId: targetChainIdHex },
          ]);
        } catch (switchErr: unknown) {
          const err = switchErr as { code?: number; message?: unknown };
          // If the chain is not added, try adding
          if (
            err?.code === 4902 ||
            (typeof err?.message === "string" &&
              /Unrecognized chain ID/i.test(err.message))
          ) {
            await provider.send("wallet_addEthereumChain", [
              {
                chainId: targetChainIdHex,
                chainName: "Monad Testnet",
                nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
                rpcUrls: [
                  import.meta.env.VITE_MONAD_RPC_URL ||
                    "https://testnet-rpc.monad.xyz",
                ],
                blockExplorerUrls: ["https://testnet.monadexplorer.com"],
              },
            ]);
          } else {
            throw switchErr;
          }
        }
      }
    } catch (e) {
      console.error("ensureMonadNetwork error", e);
      throw e;
    }
  }

  async function connectWallet() {
    if (!window.ethereum) return alert("Install MetaMask");
    try {
      const provider = new BrowserProvider(window.ethereum);
      await ensureMonadNetwork(provider);
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
    const remainingAllowance = Math.max(
      0,
      contractMaxPerWallet - userMintedCount
    );
    const remainingSupply = Math.max(0, maxSupply - totalSupply);
    if (remainingAllowance <= 0) {
      setStatus("Max per wallet reached");
      return;
    }
    if (mintQuantity < 1 || mintQuantity > remainingAllowance)
      return alert(`Quantity must be 1-${remainingAllowance}`);
    if (mintQuantity > remainingSupply) {
      return alert(`Only ${remainingSupply} left in supply`);
    }

    // Check wallet restrictions
    console.log(
      "Mint attempt - userMintedCount:",
      userMintedCount,
      "mintQuantity:",
      mintQuantity,
      "contractMaxPerWallet:",
      contractMaxPerWallet
    );

    if (userMintedCount + mintQuantity > contractMaxPerWallet) {
      return alert(
        `You can only mint ${remainingAllowance} more NFT${
          remainingAllowance === 1 ? "" : "s"
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
      const mintFn = contract.getFunction("mint");

      // Dry-run and estimate to surface revert reasons before sending
      try {
        await mintFn.staticCall(mintQuantity, { value: totalPrice });
        await mintFn.estimateGas(mintQuantity, { value: totalPrice });
      } catch (simErr) {
        const se = simErr as { shortMessage?: string; message?: string };
        const msg = se?.shortMessage || se?.message || "Simulation failed";
        const benignSimFailure =
          /missing revert data|CALL_EXCEPTION|estimateGas/i.test(msg);
        if (benignSimFailure) {
          // Some RPCs cannot simulate with value; proceed to send and rely on node validation
          console.warn("Simulation failed, proceeding to send:", msg);
          setStatus("Simulation unavailable, submitting transaction...");
        } else {
          setStatus(msg);
          throw simErr;
        }
      }

      const attemptMint = async (attempt: number): Promise<void> => {
        try {
          const tx = await mintFn(mintQuantity, { value: totalPrice });
          setStatus("Waiting for confirmation...");
          await tx.wait();
          setStatus(
            `Minted ${mintQuantity} NFT${mintQuantity > 1 ? "s" : ""}!`
          );
          await refreshContractData();
        } catch (err) {
          const rpcErr = err as { code?: number; message?: string };
          const isRateLimited =
            rpcErr?.code === -32603 &&
            typeof rpcErr?.message === "string" &&
            /rate limit|rate limited|Request is being rate limited/i.test(
              rpcErr.message
            );
          if (isRateLimited && attempt < 3) {
            const delayMs = 500 * Math.pow(2, attempt); // 500, 1000, 2000
            setStatus(
              `RPC rate limited, retrying in ${Math.round(delayMs / 1000)}s...`
            );
            await new Promise((res) => setTimeout(res, delayMs));
            return attemptMint(attempt + 1);
          }
          throw err;
        }
      };

      await attemptMint(0);
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
        // refresh data for the new account
        setTimeout(() => {
          refreshContractData();
        }, 0);
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
        {!isConfigured && (
          <div className="mt-2 mb-4 p-3 bg-red-600/70 rounded">
            <div className="text-sm font-semibold">
              Environment not configured
            </div>
            <div className="text-xs text-red-50 mt-1">
              Set <code>VITE_CONTRACT_ADDRESS</code> in your Vercel project
              Environment Variables and redeploy. Optionally set{" "}
              <code>VITE_MONAD_RPC_URL</code>.
            </div>
          </div>
        )}
        <p className="text-xs md:text-sm text-gray-300 mb-4">
          Public mint ⭐ max {contractMaxPerWallet} per wallet ⭐
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
              Quantity (1-{contractMaxPerWallet}):
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
                max={Math.min(
                  contractMaxPerWallet,
                  contractMaxPerWallet - userMintedCount
                )}
                value={mintQuantity}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 1;
                  const maxAllowed = Math.min(
                    contractMaxPerWallet,
                    contractMaxPerWallet - userMintedCount
                  );
                  setMintQuantity(Math.min(maxAllowed, Math.max(1, val)));
                }}
                className="w-16 px-2 py-1 bg-gray-700 text-white rounded text-center"
              />
              <button
                onClick={() =>
                  setMintQuantity(
                    Math.min(
                      contractMaxPerWallet,
                      Math.min(
                        contractMaxPerWallet - userMintedCount,
                        mintQuantity + 1
                      )
                    )
                  )
                }
                disabled={
                  mintQuantity >=
                  Math.min(
                    contractMaxPerWallet,
                    contractMaxPerWallet - userMintedCount
                  )
                }
                className="px-3 py-1 bg-gray-600 rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                +
              </button>
            </div>
            <div className="text-xs text-gray-400 mt-1">
              You've minted: {userMintedCount}/{contractMaxPerWallet} NFTs
              {userMintedCount >= contractMaxPerWallet && (
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
                disabled={
                  minting ||
                  userMintedCount >= contractMaxPerWallet ||
                  contractMaxPerWallet - userMintedCount <= 0
                }
                className={`px-5 py-2 rounded w-full sm:w-auto ${
                  minting ||
                  userMintedCount >= contractMaxPerWallet ||
                  contractMaxPerWallet - userMintedCount <= 0
                    ? "bg-gray-600 cursor-not-allowed"
                    : "bg-green-500 hover:bg-green-600"
                }`}
              >
                {minting
                  ? "Minting..."
                  : userMintedCount >= contractMaxPerWallet ||
                    contractMaxPerWallet - userMintedCount <= 0
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

        <div className="mt-6 md:mt-8 text-lg md:text-sm text-gray-300 w-full text-right">
          created by{" "}
          <a
            href="https://x.com/Kae_XVI"
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-white hover:text-blue-300"
          >
            @North
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              className="inline ml-1 align-[-2px] fill-current"
            >
              <path d="M23.954 4.569c-.885.392-1.83.656-2.825.775 1.014-.608 1.794-1.571 2.163-2.724-.95.564-2.005.974-3.127 1.195-.897-.957-2.178-1.554-3.594-1.554-2.723 0-4.932 2.208-4.932 4.932 0 .387.045.763.127 1.124-4.096-.205-7.73-2.168-10.164-5.149-.424.722-.666 1.561-.666 2.457 0 1.695.863 3.188 2.175 4.065-.8-.026-1.553-.245-2.21-.612v.062c0 2.367 1.683 4.342 3.918 4.792-.41.11-.844.17-1.29.17-.315 0-.624-.03-.924-.086.624 1.951 2.438 3.373 4.584 3.411-1.68 1.318-3.8 2.104-6.102 2.104-.396 0-.788-.023-1.175-.068 2.179 1.397 4.768 2.213 7.548 2.213 9.055 0 14.01-7.503 14.01-14.009 0-.213-.004-.425-.013-.636.962-.693 1.797-1.56 2.457-2.548z" />
            </svg>
          </a>
        </div>
      </div>
    </div>
  );
}
