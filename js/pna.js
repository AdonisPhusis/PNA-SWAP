/**
 * pna - Minimal Trustless Cross-Chain Swap
 *
 * Supports: BTC <-> USDC via M1 settlement rail (FlowSwap 3-Secret)
 * User generates S_user client-side, LP handles all HTLCs.
 */

// =============================================================================
// ASSETS CONFIGURATION
// =============================================================================

const ASSETS = {
    BTC: {
        symbol: 'BTC',
        name: 'Bitcoin',
        icon: '\u20bf',
        network: 'Bitcoin Signet',
        decimals: 8,
        color: '#f7931a',
        addressPattern: /^(tb1|[mn2])[a-zA-HJ-NP-Z0-9]{25,62}$/,
        addressPlaceholder: 'tb1q...',
    },
    USDC: {
        symbol: 'USDC',
        name: 'USDC',
        icon: '$',
        network: 'Base',
        decimals: 6,
        color: '#2775ca',
        addressPattern: /^0x[a-fA-F0-9]{40}$/,
        addressPlaceholder: '0x...',
    },
    M1: {
        symbol: 'M1',
        name: 'M1',
        icon: '\u039c',
        network: 'BATHRON',
        decimals: 8,
        color: '#3b82f6',
        addressPattern: /^[xy][a-zA-HJ-NP-Z0-9]{33}$/,
        addressPlaceholder: 'y...',
    },
};

// Mock rates (relative to USD)
const MOCK_RATES = {
    BTC: 98500,
    USDC: 1,
    M1: 1,  // M1 pegged to M0 which tracks USD via settlement
};

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
    // LP endpoints - multi-LP: queries all, picks best rate
    SDK_URLS: [
        'http://57.131.33.152:8080',  // LP1 (OP1)
        'http://57.131.33.214:8080',  // LP2 (OP2)
    ],
    STATUS_REFRESH_MS: 5000,
    QUOTE_REFRESH_MS: 10000,
    MIN_AMOUNT: 0.0001,
    MAX_AMOUNT: {
        BTC: 1.0,
        USDC: 100000,
        M1: 100000,
    },
};

// =============================================================================
// EVM / MetaMask Configuration (USDC -> BTC reverse flow)
// =============================================================================

const EVM_CONFIG = {
    CHAIN_ID: 84532,                // Base Sepolia
    CHAIN_ID_HEX: '0x14a34',
    CHAIN_NAME: 'Base Sepolia',
    RPC_URL: 'https://sepolia.base.org',
    EXPLORER_URL: 'https://sepolia.basescan.org',
    USDC_ADDRESS: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    HTLC3S_ADDRESS: '0x2493EaaaBa6B129962c8967AaEE6bF11D0277756',
    USDC_DECIMALS: 6,
};

// Minimal ABIs
const USDC_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

const HTLC3S_ABI = [
    'function create(address recipient, address token, uint256 amount, bytes32 hashUser, bytes32 hashLP1, bytes32 hashLP2, uint256 timelock) returns (bytes32)',
    'event HTLCCreated(bytes32 indexed id, address indexed sender, address indexed recipient, address token, uint256 amount, bytes32 hashUser, bytes32 hashLP1, bytes32 hashLP2, uint256 timelock)',
];

// MetaMask state
let metamaskState = {
    connected: false,
    address: null,
    provider: null,
    signer: null,
};

// Current LP info (fetched from SDK)
let currentLP = {
    id: null,
    name: 'Connecting...',
    pairs: {},
    inventory: {},
};

// Current quote (fetched from SDK)
let currentQuote = null;

// =============================================================================
// STATE
// =============================================================================

const State = {
    fromAsset: 'BTC',
    toAsset: 'USDC',
    inputAmount: 0,
    outputAmount: 0,
    destAddress: '',
    currentSwap: null,   // Active FlowSwap state
    S_user: null,        // User's secret (client-side only)
    statusInterval: null,
    modalTarget: null,   // 'from' or 'to'
    activeLpUrl: null,   // Selected LP URL for current swap
    routeType: null,     // 'full' or 'perleg'
    routeLegs: null,     // { leg1: {..., _url}, leg2: {..., _url} } when perleg
};

/**
 * Get the active LP URL. Falls back to first configured LP.
 */
function getLpUrl() {
    return State.activeLpUrl || CONFIG.SDK_URLS[0];
}

// =============================================================================
// DOM ELEMENTS
// =============================================================================

const DOM = {
    inputAmount: document.getElementById('input-amount'),
    outputAmount: document.getElementById('output-amount'),
    rateValue: document.getElementById('rate-value'),
    routeValue: document.getElementById('route-value'),
    timeValue: document.getElementById('time-value'),
    btcFinalityValue: document.getElementById('btc-finality-value'),
    destAddress: document.getElementById('dest-address'),
    destLabel: document.getElementById('dest-label'),
    swapBtn: document.getElementById('swap-btn'),
    swapModal: document.getElementById('swap-modal'),
    swapId: document.getElementById('swap-id'),
    statusMessage: document.getElementById('status-message'),
    newSwapBtn: document.getElementById('new-swap-btn'),
    btcSentBtn: document.getElementById('btc-sent-btn'),
    // Deposit box
    depositBox: document.getElementById('deposit-box'),
    depositAmount: document.getElementById('deposit-amount'),
    depositAddress: document.getElementById('deposit-address'),
    // Tx links
    txLinks: document.getElementById('tx-links'),
    txLinkBtc: document.getElementById('tx-link-btc'),
    txLinkEvm: document.getElementById('tx-link-evm'),
    // Asset selectors
    fromIcon: document.getElementById('from-icon'),
    fromName: document.getElementById('from-name'),
    fromNetwork: document.getElementById('from-network'),
    fromBalance: document.getElementById('from-balance'),
    toIcon: document.getElementById('to-icon'),
    toName: document.getElementById('to-name'),
    toNetwork: document.getElementById('to-network'),
    // Modal
    assetModal: document.getElementById('asset-modal'),
    assetList: document.getElementById('asset-list'),
};

// =============================================================================
// CRYPTO UTILITIES (client-side secret generation)
// =============================================================================

/**
 * Generate a 32-byte random secret as hex string.
 * Uses Web Crypto API for secure randomness.
 */
function generateSecret() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute SHA256 hash of hex string.
 * Uses ethers.js (works over HTTP, no crypto.subtle needed).
 */
async function sha256hex(hexStr) {
    return ethers.sha256('0x' + hexStr).slice(2);
}

// =============================================================================
// METAMASK CONNECTION (for USDC -> BTC reverse flow)
// =============================================================================

async function connectMetaMask() {
    if (!window.ethereum) {
        throw new Error('MetaMask not installed. Please install MetaMask to swap USDC.');
    }

    const provider = new ethers.BrowserProvider(window.ethereum);

    // Request accounts
    const accounts = await provider.send('eth_requestAccounts', []);
    if (!accounts || accounts.length === 0) {
        throw new Error('No MetaMask account selected');
    }

    // Switch to Base Sepolia if needed
    try {
        await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: EVM_CONFIG.CHAIN_ID_HEX }],
        });
    } catch (switchError) {
        // Chain not added — add it
        if (switchError.code === 4902) {
            await window.ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: EVM_CONFIG.CHAIN_ID_HEX,
                    chainName: EVM_CONFIG.CHAIN_NAME,
                    rpcUrls: [EVM_CONFIG.RPC_URL],
                    blockExplorerUrls: [EVM_CONFIG.EXPLORER_URL],
                    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                }],
            });
        } else {
            throw switchError;
        }
    }

    const signer = await provider.getSigner();

    metamaskState = {
        connected: true,
        address: accounts[0],
        provider,
        signer,
    };

    console.log('[pna] MetaMask connected:', accounts[0]);
    return metamaskState;
}

/**
 * Approve USDC + create 3-secret HTLC on EVM via MetaMask.
 * Returns the htlc_id from the contract event.
 */
async function createUSDCHTLC(params) {
    const { signer } = metamaskState;
    if (!signer) throw new Error('MetaMask not connected');

    const amountRaw = BigInt(Math.round(params.amount * (10 ** EVM_CONFIG.USDC_DECIMALS)));

    // Step 1: Approve USDC spending
    console.log('[pna] Approving USDC:', amountRaw.toString());
    const usdc = new ethers.Contract(EVM_CONFIG.USDC_ADDRESS, USDC_ABI, signer);
    const approveTx = await usdc.approve(EVM_CONFIG.HTLC3S_ADDRESS, amountRaw);
    await approveTx.wait();
    console.log('[pna] USDC approved, tx:', approveTx.hash);

    // Step 2: Create HTLC
    const timelock = Math.floor(Date.now() / 1000) + params.timelock_seconds;
    console.log('[pna] Creating HTLC3S, timelock:', timelock);

    const htlc3s = new ethers.Contract(EVM_CONFIG.HTLC3S_ADDRESS, HTLC3S_ABI, signer);
    const createTx = await htlc3s.create(
        params.recipient,
        EVM_CONFIG.USDC_ADDRESS,
        amountRaw,
        '0x' + params.H_user,
        '0x' + params.H_lp1,
        '0x' + params.H_lp2,
        timelock,
    );

    const receipt = await createTx.wait();
    console.log('[pna] HTLC created, tx:', createTx.hash);

    // Extract htlc_id from event logs
    // The HTLCCreated event has `bytes32 indexed id` as topics[1]
    let htlcId = null;
    const contractAddr = EVM_CONFIG.HTLC3S_ADDRESS.toLowerCase();
    for (const logEntry of receipt.logs) {
        if (logEntry.address.toLowerCase() === contractAddr && logEntry.topics.length >= 2) {
            htlcId = logEntry.topics[1]; // indexed htlc_id
            break;
        }
    }

    if (!htlcId) {
        // Fallback: use tx hash as reference
        console.warn('[pna] Could not extract htlc_id from event, using tx hash');
        htlcId = createTx.hash;
    }

    return {
        htlc_id: htlcId,
        lock_txhash: createTx.hash,
        approve_txhash: approveTx.hash,
    };
}

// =============================================================================
// ASSET SELECTION
// =============================================================================

function openAssetModal(target) {
    State.modalTarget = target;

    const currentAsset = target === 'from' ? State.fromAsset : State.toAsset;
    const otherAsset = target === 'from' ? State.toAsset : State.fromAsset;

    let html = '';
    for (const [symbol, asset] of Object.entries(ASSETS)) {
        const isSelected = symbol === currentAsset;
        const isOtherSide = symbol === otherAsset;

        html += `
            <div class="asset-item ${isSelected ? 'selected' : ''}"
                 onclick="selectAsset('${symbol}')">
                <span class="asset-item-icon" style="color: ${asset.color}">${asset.icon}</span>
                <div class="asset-item-info">
                    <span class="asset-item-name">${asset.name}</span>
                    <span class="asset-item-network">${asset.network}</span>
                </div>
                ${isSelected ? '<span class="asset-item-check">&#10003;</span>' : ''}
                ${isOtherSide ? '<span class="asset-item-swap">&#8644;</span>' : ''}
            </div>
        `;
    }

    DOM.assetList.innerHTML = html;
    DOM.assetModal.classList.remove('hidden');
}

function closeAssetModal() {
    DOM.assetModal.classList.add('hidden');
    State.modalTarget = null;
}

function closeSwapModal() {
    if (State.currentSwap) {
        const currentState = State.currentSwap.state || '';
        const terminalStates = ['completed', 'failed', 'expired', 'refunded'];
        if (terminalStates.includes(currentState)) {
            // Swap finished — full reset
            resetSwap();
            return;
        }
        // Before user sent funds — just hide modal, keep form intact
        if (currentState === 'awaiting_btc' || currentState === 'awaiting_usdc') {
            DOM.swapModal.classList.add('hidden');
            // Stop polling
            if (State.statusInterval) {
                clearInterval(State.statusInterval);
                State.statusInterval = null;
            }
            State.currentSwap = null;
            State.S_user = null;
            State.activeLpUrl = null;
            // Re-enable swap button
            DOM.swapBtn.classList.remove('loading');
            updateButtonState();
            return;
        }
        // Funds in flight — can't close
        return;
    }
    resetSwap();
}

async function selectAsset(symbol) {
    if (!State.modalTarget) return;

    const otherAsset = State.modalTarget === 'from' ? State.toAsset : State.fromAsset;

    // If selecting the asset from the other side, swap them
    if (symbol === otherAsset) {
        const temp = State.fromAsset;
        State.fromAsset = State.toAsset;
        State.toAsset = temp;
    } else {
        // Normal selection
        if (State.modalTarget === 'from') {
            State.fromAsset = symbol;
        } else {
            State.toAsset = symbol;
        }
    }

    closeAssetModal();
    updateAssetDisplay();
    await updateRateDisplay();
    await onInputChange();
}

async function swapDirection() {
    // Save current INPUT value (stays the same, just different asset)
    const previousInput = State.inputAmount;

    // Swap from and to assets
    const temp = State.fromAsset;
    State.fromAsset = State.toAsset;
    State.toAsset = temp;

    // Keep the same INPUT value (now it's the other asset)
    State.inputAmount = previousInput;
    DOM.outputAmount.textContent = '...';

    // Update display (asset labels)
    updateAssetDisplay();

    // Recalculate output with new direction
    if (State.inputAmount > 0) {
        // Force immediate recalculation (skip debounce)
        const newOutput = await calculateOutput(State.inputAmount);
        State.outputAmount = newOutput;

        // Check for errors (min/max)
        if (currentQuote && currentQuote.error === 'min') {
            DOM.outputAmount.textContent = `Min: ${formatNumber(currentQuote.minAmount, 2)} ${currentQuote.asset}`;
        } else if (currentQuote && currentQuote.error === 'max') {
            DOM.outputAmount.textContent = `Max: ${formatNumber(currentQuote.maxAmount, 2)} ${currentQuote.asset}`;
        } else {
            const toAsset = ASSETS[State.toAsset];
            const displayDecimals = State.outputAmount >= 1000 ? 2 : (toAsset.decimals > 4 ? 4 : toAsset.decimals);
            DOM.outputAmount.textContent = formatNumber(State.outputAmount, displayDecimals);
        }
    }

    await updateRateDisplay();
    updateButtonState();
}

function updateAssetDisplay() {
    const from = ASSETS[State.fromAsset];
    const to = ASSETS[State.toAsset];

    // Update from side
    DOM.fromIcon.textContent = from.icon;
    DOM.fromIcon.style.color = from.color;
    DOM.fromName.textContent = from.symbol;
    DOM.fromNetwork.textContent = from.network;

    // Update to side
    DOM.toIcon.textContent = to.icon;
    DOM.toIcon.style.color = to.color;
    DOM.toName.textContent = to.symbol;
    DOM.toNetwork.textContent = to.network;

    // Update destination address placeholder
    DOM.destAddress.placeholder = to.addressPlaceholder;
    DOM.destLabel.textContent = `Your ${to.symbol} address (${to.network})`;

}

// =============================================================================
// LP & QUOTE FETCHING
// =============================================================================

async function fetchLPInfo() {
    try {
        // Query all LPs in parallel
        const results = await Promise.allSettled(
            CONFIG.SDK_URLS.map(url =>
                fetch(`${url}/api/lp/info`, { signal: AbortSignal.timeout(15000) })
                    .then(r => r.ok ? r.json() : null)
                    .then(data => data ? { ...data, _url: url } : null)
            )
        );

        const online = results
            .filter(r => r.status === 'fulfilled' && r.value)
            .map(r => r.value);

        if (online.length === 0) {
            currentLP.name = 'LP Offline';
            updateLPDisplay();
            return null;
        }

        // Use first available LP as default info
        const first = online[0];
        currentLP = {
            id: first.lp_id,
            name: online.length > 1 ? `${online.length} LPs online` : first.name,
            pairs: first.pairs,
            inventory: first.inventory,
        };

        console.log(`[pna] ${online.length} LP(s) online:`, online.map(lp => lp.name || lp.lp_id));
        updateLPDisplay();
        return first;
    } catch (e) {
        console.error('[pna] Failed to fetch LP info:', e);
        currentLP.name = 'LP Offline';
        updateLPDisplay();
        return null;
    }
}

async function fetchQuote(fromAsset, toAsset, amount) {
    if (amount <= 0) return null;

    try {
        // Query all LPs in parallel for best rate
        const quoteUrl = (base) => `${base}/api/quote?from=${fromAsset}&to=${toAsset}&amount=${amount}`;

        const results = await Promise.allSettled(
            CONFIG.SDK_URLS.map(url =>
                fetch(quoteUrl(url), { signal: AbortSignal.timeout(15000) })
                    .then(async r => {
                        if (!r.ok) {
                            const error = await r.json().catch(() => ({}));
                            return { _error: error.detail || `HTTP ${r.status}`, _url: url };
                        }
                        const data = await r.json();
                        return { ...data, _url: url };
                    })
            )
        );

        const quotes = results
            .filter(r => r.status === 'fulfilled' && r.value && !r.value._error)
            .map(r => r.value);

        // Check for error messages from rejected quotes
        const errors = results
            .filter(r => r.status === 'fulfilled' && r.value && r.value._error)
            .map(r => r.value);

        if (quotes.length === 0) {
            // Use first error for user feedback
            if (errors.length > 0) {
                const errorMsg = errors[0]._error;
                if (errorMsg.includes('below minimum')) {
                    const match = errorMsg.match(/minimum: ([\d.]+)/);
                    if (match) {
                        currentQuote = { error: 'min', minAmount: parseFloat(match[1]), asset: fromAsset };
                    }
                } else if (errorMsg.includes('above maximum')) {
                    const match = errorMsg.match(/maximum: ([\d.]+)/);
                    if (match) {
                        currentQuote = { error: 'max', maxAmount: parseFloat(match[1]), asset: fromAsset };
                    }
                }
                console.warn('[pna] All quotes rejected:', errorMsg);
            }
            return null;
        }

        // Liquidity-first: filter LPs that can actually fill the order
        const fillable = quotes.filter(q => q.inventory_ok !== false);

        if (fillable.length === 0) {
            // No LP has enough liquidity — find best max_amount for feedback
            const bestMax = quotes.reduce((a, b) =>
                parseFloat(b.max_amount || 0) > parseFloat(a.max_amount || 0) ? b : a
            );
            currentQuote = { error: 'max', maxAmount: bestMax.max_amount, asset: fromAsset };
            console.warn(`[pna] No LP has enough liquidity. Best max: ${bestMax.max_amount} ${fromAsset}`);
            return null;
        }

        // Among fillable LPs, pick best rate (highest toAmount for user)
        const best = fillable.reduce((a, b) =>
            parseFloat(b.toAmount || b.to_amount || 0) > parseFloat(a.toAmount || a.to_amount || 0) ? b : a
        );

        // Store the selected LP URL — but don't override during active swap
        if (!State.currentSwap) {
            State.activeLpUrl = best._url;
        }
        console.log(`[pna] Best quote from ${best._url}: ${best.toAmount || best.to_amount} (${quotes.length} LP(s) responded)`);

        currentQuote = best;
        return currentQuote;
    } catch (e) {
        console.error('[pna] Quote error:', e);
        currentQuote = null;
        return null;
    }
}

// =============================================================================
// PER-LEG ROUTING (Blueprint 16 — Multi-LP)
// =============================================================================

/**
 * Query all LPs for a single leg (X→M1 or M1→Y).
 */
async function fetchLegQuotes(fromAsset, toAsset, amount) {
    if (amount <= 0) return [];
    const results = await Promise.allSettled(
        CONFIG.SDK_URLS.map(url =>
            fetch(`${url}/api/quote/leg?from=${fromAsset}&to=${toAsset}&amount=${amount}`,
                { signal: AbortSignal.timeout(15000) })
                .then(async r => {
                    if (!r.ok) return null;
                    const data = await r.json();
                    return { ...data, _url: url };
                })
        )
    );
    return results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);
}

/**
 * Liquidity-first, then best price — for a single leg.
 */
function selectBestLeg(quotes) {
    if (!quotes || quotes.length === 0) return null;
    const fillable = quotes.filter(q => q.inventory_ok !== false);
    if (fillable.length === 0) return null;
    return fillable.reduce((a, b) =>
        parseFloat(b.to_amount || 0) > parseFloat(a.to_amount || 0) ? b : a
    );
}

/**
 * Compose a per-leg route: query leg 1 (from→M1), then leg 2 (M1→to).
 */
async function fetchPerLegRoute(fromAsset, toAsset, amount) {
    // Only for cross-chain (both sides != M1)
    if (fromAsset === 'M1' || toAsset === 'M1') return null;

    try {
        // Leg 1: from → M1
        const leg1Quotes = await fetchLegQuotes(fromAsset, 'M1', amount);
        const bestLeg1 = selectBestLeg(leg1Quotes);
        if (!bestLeg1) return null;

        // Leg 2: M1 → to (use leg 1 output as input)
        const leg2Quotes = await fetchLegQuotes('M1', toAsset, bestLeg1.to_amount);
        const bestLeg2 = selectBestLeg(leg2Quotes);
        if (!bestLeg2) return null;

        return {
            type: 'perleg',
            leg1: bestLeg1,
            leg2: bestLeg2,
            total_output: bestLeg2.to_amount,
            total_spread: bestLeg1.spread_percent + bestLeg2.spread_percent,
            route: `${fromAsset} \u2192 M1 (${bestLeg1.lp_name}) \u2192 ${toAsset} (${bestLeg2.lp_name})`,
            settlement_time_seconds: bestLeg1.settlement_time_seconds + bestLeg2.settlement_time_seconds,
            settlement_time_human: `~${Math.ceil(
                (bestLeg1.settlement_time_seconds + bestLeg2.settlement_time_seconds) / 60
            )} min`,
            confirmations_required: bestLeg1.confirmations_required,
            confirmations_breakdown: bestLeg1.confirmations_breakdown,
        };
    } catch (e) {
        console.warn('[pna] Per-leg route error:', e);
        return null;
    }
}

/**
 * Compare full-route (single LP) vs per-leg (multi-LP). Pick best output.
 */
async function fetchBestRoute(fromAsset, toAsset, amount) {
    if (amount <= 0) return null;

    // M1 direct legs — skip per-leg composition
    if (fromAsset === 'M1' || toAsset === 'M1') {
        const quote = await fetchQuote(fromAsset, toAsset, amount);
        if (quote) {
            State.routeType = 'full';
            State.routeLegs = null;
        }
        return quote;
    }

    // Query both in parallel
    const [fullResult, perLegResult] = await Promise.allSettled([
        fetchQuote(fromAsset, toAsset, amount),
        fetchPerLegRoute(fromAsset, toAsset, amount),
    ]);

    const fullRoute = fullResult.status === 'fulfilled' ? fullResult.value : null;
    const perLeg = perLegResult.status === 'fulfilled' ? perLegResult.value : null;

    if (!fullRoute && !perLeg) return null;

    // Only full-route available
    if (!perLeg) {
        State.routeType = 'full';
        State.routeLegs = null;
        return fullRoute;
    }

    // Build a currentQuote-compatible object from per-leg
    function buildPerLegQuote(pl) {
        return {
            lp_id: `${pl.leg1.lp_id}+${pl.leg2.lp_id}`,
            lp_name: `${pl.leg1.lp_name} + ${pl.leg2.lp_name}`,
            from_asset: fromAsset,
            to_asset: toAsset,
            from_amount: amount,
            to_amount: pl.total_output,
            rate: pl.total_output / amount,
            route: pl.route,
            spread_percent: pl.total_spread,
            settlement_time_seconds: pl.settlement_time_seconds,
            settlement_time_human: pl.settlement_time_human,
            confirmations_required: pl.confirmations_required,
            confirmations_breakdown: pl.confirmations_breakdown,
            inventory_ok: true,
            min_amount: pl.leg1.min_amount,
            max_amount: pl.leg1.max_amount,
        };
    }

    // Only per-leg available
    if (!fullRoute) {
        State.routeType = 'perleg';
        State.routeLegs = { leg1: perLeg.leg1, leg2: perLeg.leg2 };
        State.activeLpUrl = null;
        currentQuote = buildPerLegQuote(perLeg);
        return currentQuote;
    }

    // Both available — compare to_amount
    const fullOutput = parseFloat(fullRoute.to_amount || 0);
    const perLegOutput = parseFloat(perLeg.total_output || 0);

    if (perLegOutput > fullOutput) {
        State.routeType = 'perleg';
        State.routeLegs = { leg1: perLeg.leg1, leg2: perLeg.leg2 };
        State.activeLpUrl = null;
        currentQuote = buildPerLegQuote(perLeg);
        console.log(`[pna] Per-leg route wins: ${perLegOutput} > ${fullOutput} (full)`);
        return currentQuote;
    }

    // Full-route wins (or tie)
    State.routeType = 'full';
    State.routeLegs = null;
    console.log(`[pna] Full-route wins: ${fullOutput} >= ${perLegOutput} (per-leg)`);
    return fullRoute;
}

function updateLPDisplay() {
    // Update LP name in header if element exists
    const lpNameEl = document.getElementById('lp-name');
    if (lpNameEl) {
        lpNameEl.textContent = currentLP.name;
    }
}

// =============================================================================
// RATE & QUOTE
// =============================================================================

function getRoute(fromAsset, toAsset) {
    // Use route from quote if available
    if (currentQuote && currentQuote.route) {
        return currentQuote.route;
    }
    // Default: Direct pairs via M1 rail
    if (fromAsset === 'M1' || toAsset === 'M1') {
        return `${fromAsset} → ${toAsset}`;
    }
    // Cross-chain needs M1 hop
    return `${fromAsset} → M1 → ${toAsset}`;
}

function getSettlementTime(fromAsset, toAsset) {
    // Use time from quote if available
    if (currentQuote && currentQuote.settlement_time_human) {
        return currentQuote.settlement_time_human;
    }
    // Default estimates
    if (fromAsset === 'BTC') {
        return '~20 min (6 BTC conf)';
    }
    if (fromAsset === 'M1') {
        return '~1 min';
    }
    return '~2 min';
}

async function updateRateDisplay() {
    // Use a small reference amount for rate display (avoids inflated settlement time)
    const refAmount = State.fromAsset === 'BTC' ? 0.001 : (State.fromAsset === 'USDC' ? 50 : 1);
    const quote = await fetchBestRoute(State.fromAsset, State.toAsset, refAmount);

    if (quote) {
        // Format rate display
        const rate = quote.rate;
        let rateStr;
        if (rate >= 1000) {
            rateStr = `1 ${State.fromAsset} = ${formatNumber(rate, 2)} ${State.toAsset}`;
        } else if (rate >= 1) {
            rateStr = `1 ${State.fromAsset} = ${rate.toFixed(4)} ${State.toAsset}`;
        } else {
            rateStr = `1 ${State.fromAsset} = ${rate.toFixed(8)} ${State.toAsset}`;
        }

        DOM.rateValue.textContent = rateStr;
        DOM.routeValue.textContent = quote.route;
        // Settlement = M1 rail (~1 min), BTC finality = separate
        const m1Finality = (quote.confirmations_breakdown && quote.confirmations_breakdown.m1_finality) || 60;
        DOM.timeValue.textContent = `~${Math.ceil(m1Finality / 60)} min (M1 rail)`;

        if (quote.confirmations_breakdown) {
            const cb = quote.confirmations_breakdown;
            if (cb.confirmations === 0) {
                DOM.btcFinalityValue.textContent = 'Instant (0-conf)';
            } else {
                const btcMin = Math.ceil(cb.asset_time / 60);
                DOM.btcFinalityValue.textContent = `~${btcMin} min (${cb.confirmations} conf)`;
            }
        } else {
            DOM.btcFinalityValue.textContent = quote.settlement_time_human;
        }

        // Update limits
        CONFIG.MIN_AMOUNT = quote.min_amount;
        CONFIG.MAX_AMOUNT[State.fromAsset] = quote.max_amount;
    } else {
        DOM.rateValue.textContent = 'LP offline';
        DOM.routeValue.textContent = getRoute(State.fromAsset, State.toAsset);
        DOM.timeValue.textContent = '~1 min (M1 rail)';
        DOM.btcFinalityValue.textContent = '-';
    }
}

async function calculateOutput(inputAmount) {
    if (inputAmount <= 0) return 0;

    // Fetch best route (full-route vs per-leg)
    const quote = await fetchBestRoute(State.fromAsset, State.toAsset, inputAmount);

    if (quote) {
        return quote.to_amount;
    }

    // Fallback: use last known rate
    if (currentQuote && currentQuote.rate) {
        return inputAmount * currentQuote.rate;
    }

    return 0;
}

// =============================================================================
// INPUT HANDLING
// =============================================================================

// Debounce timer for input changes
let inputDebounceTimer = null;

async function onInputChange() {
    const value = parseFloat(DOM.inputAmount.value) || 0;
    State.inputAmount = value;

    // Show loading state
    DOM.outputAmount.textContent = '...';

    // Debounce API calls (wait 300ms after user stops typing)
    if (inputDebounceTimer) {
        clearTimeout(inputDebounceTimer);
    }

    inputDebounceTimer = setTimeout(async () => {
        // Fetch real quote from SDK
        State.outputAmount = await calculateOutput(value);

        // Check for errors (min/max)
        if (currentQuote && currentQuote.error === 'min') {
            DOM.outputAmount.textContent = `Min: ${formatNumber(currentQuote.minAmount, 2)} ${currentQuote.asset}`;
            updateButtonState();
            return;
        }
        if (currentQuote && currentQuote.error === 'max') {
            DOM.outputAmount.textContent = `Max: ${formatNumber(currentQuote.maxAmount, 2)} ${currentQuote.asset}`;
            updateButtonState();
            return;
        }

        // Format output based on asset decimals
        const toAsset = ASSETS[State.toAsset];
        const displayDecimals = State.outputAmount >= 1000 ? 2 : (toAsset.decimals > 4 ? 4 : toAsset.decimals);
        DOM.outputAmount.textContent = formatNumber(State.outputAmount, displayDecimals);

        // Update rate info with actual amount's settlement time and fees
        if (currentQuote && !currentQuote.error) {
            if (currentQuote.confirmations_breakdown) {
                const cb = currentQuote.confirmations_breakdown;
                if (cb.confirmations === 0) {
                    DOM.btcFinalityValue.textContent = 'Instant (0-conf)';
                } else {
                    const btcMin = Math.ceil(cb.asset_time / 60);
                    DOM.btcFinalityValue.textContent = `~${btcMin} min (${cb.confirmations} conf)`;
                }
            }
        }

        updateButtonState();
    }, 300);
}

function onAddressChange() {
    State.destAddress = DOM.destAddress.value.trim();
    updateButtonState();
}

function updateButtonState() {
    const btn = DOM.swapBtn;
    const btnText = btn.querySelector('.btn-text');
    const fromAsset = ASSETS[State.fromAsset];
    const toAsset = ASSETS[State.toAsset];

    const hasAmount = State.inputAmount >= CONFIG.MIN_AMOUNT;
    const maxAmount = CONFIG.MAX_AMOUNT[State.fromAsset];
    const notTooMuch = State.inputAmount <= maxAmount;
    const hasAddress = toAsset.addressPattern.test(State.destAddress);

    // For USDC->BTC, check MetaMask
    const needsMetaMask = State.fromAsset === 'USDC';
    const hasMetaMask = !!window.ethereum;

    if (!hasAmount) {
        btnText.textContent = 'Enter amount';
        btn.disabled = true;
    } else if (!notTooMuch) {
        btnText.textContent = `Max ${maxAmount} ${State.fromAsset}`;
        btn.disabled = true;
    } else if (!hasAddress) {
        btnText.textContent = `Enter ${toAsset.symbol} address`;
        btn.disabled = true;
    } else if (needsMetaMask && !hasMetaMask) {
        btnText.textContent = 'Install MetaMask';
        btn.disabled = true;
    } else {
        btnText.textContent = `Swap ${State.fromAsset} \u2192 ${State.toAsset}`;
        btn.disabled = false;
    }
}

// =============================================================================
// FLOWSWAP 3S - Real Swap Flow
// =============================================================================

async function initiateSwap() {
    if (DOM.swapBtn.disabled) return;

    // Per-leg route: fallback to full-route LP for execution (Phase 4 will add init-leg)
    if (State.routeType === 'perleg') {
        const fullQuote = await fetchQuote(State.fromAsset, State.toAsset, State.inputAmount);
        if (fullQuote) {
            console.log('[pna] Per-leg display, but using full-route LP for execution (Phase 4 pending)');
        } else {
            setStatusMessage('error', 'Per-leg swap execution not yet available. No full-route LP found.');
            return;
        }
    }

    if (State.fromAsset === 'BTC' && State.toAsset === 'USDC') {
        return await initiateSwapBtcToUsdc();
    } else if (State.fromAsset === 'USDC' && State.toAsset === 'BTC') {
        return await initiateSwapUsdcToBtc();
    } else {
        setStatusMessage('error', 'Only BTC <-> USDC supported');
    }
}

// ---- BTC -> USDC (existing forward flow) ----

async function initiateSwapBtcToUsdc() {
    const btn = DOM.swapBtn;
    const btnText = btn.querySelector('.btn-text');

    try {
        btn.classList.add('loading');
        btnText.textContent = 'Creating HTLCs...';
        btn.disabled = true;

        const S_user = generateSecret();
        const H_user = await sha256hex(S_user);
        State.S_user = S_user;
        console.log('[pna] Generated H_user:', H_user.slice(0, 16) + '...');

        const initBody = {
            from_asset: 'BTC',
            to_asset: 'USDC',
            amount: State.inputAmount,
            H_user: H_user,
            user_usdc_address: State.destAddress,
        };

        const response = await fetch(`${getLpUrl()}/api/flowswap/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initBody),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        const data = await response.json();
        console.log('[pna] FlowSwap init response:', data);

        State.currentSwap = {
            swap_id: data.swap_id,
            state: data.state,
            direction: 'forward',
            from_asset: 'BTC',
            to_asset: 'USDC',
            from_amount: State.inputAmount,
            to_amount: State.outputAmount,
            dest_address: State.destAddress,
            btc_deposit_address: data.btc_deposit.address,
            btc_amount_sats: data.btc_deposit.amount_sats,
            btc_amount_btc: data.btc_deposit.amount_btc,
            instant_min_feerate: data.btc_deposit.instant_min_feerate || 4,
            usdc_amount: data.usdc_output.amount,
            evm_htlc_id: null,  // Populated after LP locks (user-commits-first)
            H_user: H_user,
            H_lp1: data.hashlocks.H_lp1,
            H_lp2: data.hashlocks.H_lp2,
            plan_expires_at: data.plan_expires_at || 0,
        };

        showFlowSwapStatus(State.currentSwap);
        startFlowSwapPolling(data.swap_id);

    } catch (error) {
        console.error('[pna] FlowSwap init error:', error);
        setStatusMessage('error', 'Swap failed: ' + error.message);
        btn.classList.remove('loading');
        btnText.textContent = `Swap BTC \u2192 USDC`;
        btn.disabled = false;
    }
}

// ---- USDC -> BTC (new reverse flow via MetaMask) ----

async function initiateSwapUsdcToBtc() {
    const btn = DOM.swapBtn;
    const btnText = btn.querySelector('.btn-text');

    try {
        btn.classList.add('loading');
        btnText.textContent = 'Connecting MetaMask...';
        btn.disabled = true;

        // Step 1: Connect MetaMask
        await connectMetaMask();
        btnText.textContent = 'Creating HTLCs...';

        // Step 2: Generate user secret
        const S_user = generateSecret();
        const H_user = await sha256hex(S_user);
        State.S_user = S_user;
        console.log('[pna] Generated H_user:', H_user.slice(0, 16) + '...');

        // Step 3: Call LP init (USDC -> BTC)
        const initBody = {
            from_asset: 'USDC',
            to_asset: 'BTC',
            amount: State.inputAmount,
            H_user: H_user,
            user_btc_claim_address: State.destAddress,
        };

        const response = await fetch(`${getLpUrl()}/api/flowswap/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initBody),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        const data = await response.json();
        console.log('[pna] FlowSwap reverse init:', data);

        // Step 4: Store swap state
        State.currentSwap = {
            swap_id: data.swap_id,
            state: data.state,
            direction: 'reverse',
            from_asset: 'USDC',
            to_asset: 'BTC',
            from_amount: State.inputAmount,
            to_amount: State.outputAmount,
            dest_address: State.destAddress,
            usdc_amount: data.usdc_deposit.amount,
            btc_amount_btc: data.btc_output.amount_btc,
            btc_amount_sats: data.btc_output.amount_sats,
            H_user: H_user,
            H_lp1: data.hashlocks.H_lp1,
            H_lp2: data.hashlocks.H_lp2,
            usdc_deposit_params: data.usdc_deposit,
            plan_expires_at: data.plan_expires_at || 0,
        };

        // Step 5: Show status and create USDC HTLC via MetaMask
        showFlowSwapStatusReverse(State.currentSwap);
        startFlowSwapPolling(data.swap_id);

        // Step 6: Create USDC HTLC on-chain
        btnText.textContent = 'Approve USDC...';
        setStatusMessage('pending', 'Approve USDC in MetaMask...');

        const htlcResult = await createUSDCHTLC({
            amount: data.usdc_deposit.amount,
            recipient: data.usdc_deposit.recipient,
            timelock_seconds: data.usdc_deposit.timelock_seconds,
            H_user: H_user,
            H_lp1: data.hashlocks.H_lp1,
            H_lp2: data.hashlocks.H_lp2,
        });

        console.log('[pna] USDC HTLC created:', htlcResult);
        State.currentSwap.evm_htlc_id = htlcResult.htlc_id;
        State.currentSwap.evm_lock_txhash = htlcResult.lock_txhash;

        // Step 7: Notify LP
        setStatusMessage('pending', 'USDC locked. Notifying LP...');
        updateStepProgress(2);

        const fundedResp = await fetch(
            `${getLpUrl()}/api/flowswap/${data.swap_id}/usdc-funded?htlc_id=${htlcResult.htlc_id}`,
            { method: 'POST' }
        );

        if (!fundedResp.ok) {
            console.warn('[pna] usdc-funded notification failed, continuing...');
        }

        // Step 8: Wait for LP to lock (user-commits-first model)
        // autoPresign deferred to lp_locked state via polling
        setStatusMessage('pending', 'USDC confirmed. LP locking BTC + M1...');

    } catch (error) {
        console.error('[pna] FlowSwap reverse error:', error);
        let msg = error.message;
        if (msg.includes('user rejected')) msg = 'Transaction rejected in MetaMask';
        setStatusMessage('error', 'Swap failed: ' + msg);
        btn.classList.remove('loading');
        btnText.textContent = `Swap USDC \u2192 BTC`;
        btn.disabled = false;
    }
}

function showFlowSwapStatus(swap) {
    DOM.swapModal.classList.remove('hidden');
    DOM.swapId.textContent = swap.swap_id;

    // Show deposit box with BTC address + feerate recommendation
    DOM.depositBox.classList.remove('hidden');
    DOM.depositAmount.textContent = `${swap.btc_amount_btc} BTC`;
    DOM.depositAddress.textContent = swap.btc_deposit_address;

    const feerate = swap.instant_min_feerate || 4;
    const feerateEl = document.getElementById('min-feerate');
    if (feerateEl) feerateEl.textContent = feerate;
    const feeSatsEl = document.getElementById('min-fee-sats');
    if (feeSatsEl) feeSatsEl.textContent = Math.ceil(feerate * 140);

    // Update step labels for FlowSwap
    document.getElementById('step1-title').textContent = 'Fund BTC';
    document.getElementById('step1-desc').textContent = 'Send BTC to HTLC address';
    document.getElementById('step2-title').textContent = 'Confirmations';
    document.getElementById('step2-desc').textContent = 'Waiting for BTC confirmation';
    document.getElementById('step3-title').textContent = 'Settlement';
    document.getElementById('step3-desc').textContent = 'LP claims BTC, USDC released';
    document.getElementById('step4-title').textContent = `${swap.usdc_amount} USDC`;
    document.getElementById('step4-desc').textContent = `To ${swap.dest_address.slice(0, 8)}...`;

    updateStepProgress(1);
    setStatusMessage('pending', 'Waiting for BTC deposit...');

    // Show "I've sent BTC" button
    DOM.btcSentBtn.classList.remove('hidden');
}

function showFlowSwapStatusReverse(swap) {
    DOM.swapModal.classList.remove('hidden');
    DOM.swapId.textContent = swap.swap_id;

    // No deposit box for reverse — user locks USDC via MetaMask
    DOM.depositBox.classList.add('hidden');
    DOM.btcSentBtn.classList.add('hidden');

    // Update step labels for reverse flow
    document.getElementById('step1-title').textContent = 'Lock USDC';
    document.getElementById('step1-desc').textContent = 'Approve + create HTLC via MetaMask';
    document.getElementById('step2-title').textContent = 'LP Notified';
    document.getElementById('step2-desc').textContent = 'LP verifies USDC HTLC on-chain';
    document.getElementById('step3-title').textContent = 'Settlement';
    document.getElementById('step3-desc').textContent = 'LP claims USDC, BTC released';
    document.getElementById('step4-title').textContent = `${swap.btc_amount_btc} BTC`;
    document.getElementById('step4-desc').textContent = `To ${swap.dest_address.slice(0, 12)}...`;

    updateStepProgress(1);
    setStatusMessage('pending', 'Connecting MetaMask...');
}

function updateStepProgress(currentStep) {
    const steps = document.querySelectorAll('.step');

    steps.forEach((step, index) => {
        const stepNum = index + 1;
        step.classList.remove('active', 'completed');

        if (stepNum < currentStep) {
            step.classList.add('completed');
        } else if (stepNum === currentStep) {
            step.classList.add('active');
        }
    });
}

function setStatusMessage(type, message) {
    DOM.statusMessage.className = `status-message ${type}`;
    DOM.statusMessage.textContent = message;
}

// =============================================================================
// FLOWSWAP POLLING & STATE MACHINE
// =============================================================================

function startFlowSwapPolling(swapId) {
    // Clear any existing interval
    if (State.statusInterval) {
        clearInterval(State.statusInterval);
    }

    State.statusInterval = setInterval(async () => {
        if (!State.currentSwap) return;

        try {
            const response = await fetch(`${getLpUrl()}/api/flowswap/${swapId}`);
            if (!response.ok) return;

            const data = await response.json();
            handleFlowSwapStateChange(data);
        } catch (e) {
            console.warn('[pna] Poll error:', e);
        }
    }, CONFIG.STATUS_REFRESH_MS);
}

function handleFlowSwapStateChange(data) {
    const swap = State.currentSwap;
    if (!swap) return;

    const prevState = swap.state;
    swap.state = data.state;

    // Allow btc_funded to re-process (stability countdown updates)
    if (prevState === data.state && data.state !== 'btc_funded') return;

    console.log(`[pna] State: ${prevState} -> ${data.state}`);

    const isReverse = swap.direction === 'reverse';

    switch (data.state) {
        // --- Forward flow (BTC -> USDC) ---
        case 'awaiting_btc':
            updateStepProgress(1);
            setStatusMessage('pending', 'Waiting for BTC deposit...');
            break;

        case 'btc_funded':
            updateStepProgress(2);
            DOM.btcSentBtn.classList.add('hidden');
            DOM.depositBox.classList.add('hidden');

            // Show stability countdown or locking message
            if (data.stability_check_until) {
                const remaining = data.stability_check_until - Math.floor(Date.now() / 1000);
                if (remaining > 0) {
                    setStatusMessage('pending', `Verifying deposit... ${remaining}s`);
                } else {
                    setStatusMessage('pending', 'Deposit verified. LP locking USDC + M1...');
                }
            } else {
                setStatusMessage('pending', 'BTC detected. LP locking USDC + M1...');
            }

            if (data.btc && data.btc.fund_txid) {
                showTxLink('btc', data.btc.fund_txid);
            }
            // autoPresign moved to lp_locked (user-commits-first model)
            break;

        case 'lp_locked':
            updateStepProgress(2);
            setStatusMessage('pending', isReverse
                ? 'LP locked BTC + M1. Completing swap...'
                : 'LP locked USDC + M1. Completing swap...');
            DOM.btcSentBtn.classList.add('hidden');
            DOM.depositBox.classList.add('hidden');

            // Show LP lock TX links
            if (data.evm && data.evm.htlc_id) {
                swap.evm_htlc_id = data.evm.htlc_id;
            }
            if (data.evm && data.evm.lock_txhash) {
                showTxLink('evm', data.evm.lock_txhash);
            }
            if (data.btc && data.btc.fund_txid) {
                showTxLink('btc', data.btc.fund_txid);
            }

            // Now safe to presign — LP has committed on-chain
            autoPresign();
            break;

        case 'btc_claimed':
            updateStepProgress(3);
            if (isReverse) {
                setStatusMessage('pending', 'BTC sent to your address. Finalizing...');
            } else {
                const claimConfs = (data.btc && data.btc.claim_confs) || 0;
                setStatusMessage('pending',
                    `BTC claimed by LP. Waiting for confirmation (${claimConfs}/1)...`);
            }
            DOM.depositBox.classList.add('hidden');

            if (data.btc && data.btc.claim_txid) {
                showTxLink('btc', data.btc.claim_txid);
            }
            break;

        // --- Reverse flow (USDC -> BTC) ---
        case 'awaiting_usdc':
            updateStepProgress(1);
            setStatusMessage('pending', 'Create USDC HTLC via MetaMask...');
            break;

        case 'usdc_funded':
            updateStepProgress(2);
            setStatusMessage('pending', 'USDC locked. LP locking BTC + M1...');
            if (swap.evm_lock_txhash) {
                showTxLink('evm', swap.evm_lock_txhash);
            }
            break;

        // --- Common terminal states ---
        case 'expired':
            setStatusMessage('error', 'Plan expired. No funds were locked by LP.');
            DOM.newSwapBtn.classList.remove('hidden');
            DOM.btcSentBtn.classList.add('hidden');
            DOM.depositBox.classList.add('hidden');

            if (State.statusInterval) {
                clearInterval(State.statusInterval);
                State.statusInterval = null;
            }
            break;

        case 'completing':
            updateStepProgress(3);
            if (isReverse) {
                setStatusMessage('pending', 'Finalizing... BTC being sent to your wallet.');
            } else {
                const confs2 = (data.btc && data.btc.claim_confs) || 0;
                if (confs2 < 1) {
                    setStatusMessage('pending',
                        `Waiting for BTC confirmation (${confs2}/1) before USDC release...`);
                } else {
                    setStatusMessage('pending', 'BTC confirmed. USDC being sent to your wallet...');
                }
            }
            break;

        case 'completed':
            updateStepProgress(4);
            DOM.depositBox.classList.add('hidden');

            if (isReverse) {
                setStatusMessage('success',
                    `Success! ${swap.btc_amount_btc} BTC sent to ${swap.dest_address.slice(0, 12)}...`);
                if (data.btc && data.btc.claim_txid) {
                    showTxLink('btc', data.btc.claim_txid);
                }
            } else {
                const displayDecimals = swap.usdc_amount >= 1000 ? 2 : 4;
                setStatusMessage('success',
                    `Success! ${formatNumber(swap.usdc_amount, displayDecimals)} USDC sent to ${swap.dest_address.slice(0, 10)}...`);
                if (data.evm && data.evm.claim_txhash) {
                    showTxLink('evm', data.evm.claim_txhash);
                }
            }

            DOM.btcSentBtn.classList.add('hidden');
            DOM.newSwapBtn.classList.remove('hidden');

            if (State.statusInterval) {
                clearInterval(State.statusInterval);
                State.statusInterval = null;
            }
            break;

        case 'failed':
            setStatusMessage('error', isReverse
                ? 'Swap failed. USDC is safe if HTLC was not created.'
                : 'Swap failed. Your BTC is safe if unfunded.');
            DOM.newSwapBtn.classList.remove('hidden');
            DOM.btcSentBtn.classList.add('hidden');

            if (State.statusInterval) {
                clearInterval(State.statusInterval);
                State.statusInterval = null;
            }
            break;

        case 'refunded': {
            const refundTxid = data.btc?.refund_txid || '';
            const refundAddr = data.btc?.refund_address || '';
            let refundMsg = 'Swap timed out. BTC auto-refunded.';
            if (refundAddr) refundMsg += ` Sent to ${refundAddr.slice(0, 12)}...`;
            setStatusMessage('warning', refundMsg);
            if (refundTxid) showTxLink('btc', refundTxid);
            DOM.newSwapBtn.classList.remove('hidden');
            DOM.btcSentBtn.classList.add('hidden');

            if (State.statusInterval) {
                clearInterval(State.statusInterval);
                State.statusInterval = null;
            }
            break;
        }
    }
}

function showTxLink(chain, txid) {
    DOM.txLinks.classList.remove('hidden');

    if (chain === 'btc') {
        DOM.txLinkBtc.classList.remove('hidden');
        DOM.txLinkBtc.href = `https://mempool.space/signet/tx/${txid}`;
        DOM.txLinkBtc.textContent = `BTC TX: ${txid.slice(0, 8)}...`;
    } else if (chain === 'evm') {
        DOM.txLinkEvm.classList.remove('hidden');
        DOM.txLinkEvm.href = `https://sepolia.basescan.org/tx/${txid}`;
        DOM.txLinkEvm.textContent = `USDC TX: ${txid.slice(0, 10)}...`;
    }
}

// =============================================================================
// USER ACTIONS
// =============================================================================

/**
 * User clicks "I've sent BTC" — notify LP to check funding.
 */
async function notifyBtcFunded() {
    if (!State.currentSwap) return;

    const swap = State.currentSwap;
    const btn = DOM.btcSentBtn;
    btn.textContent = 'Checking...';
    btn.disabled = true;

    try {
        const response = await fetch(`${getLpUrl()}/api/flowswap/${swap.swap_id}/btc-funded`, {
            method: 'POST',
        });

        if (!response.ok) {
            const error = await response.json();
            const msg = error.detail || 'BTC not confirmed yet';
            setStatusMessage('pending', msg + '. Please wait and try again.');
            btn.textContent = "I've sent BTC";
            btn.disabled = false;
            return;
        }

        const data = await response.json();
        console.log('[pna] BTC funded:', data);

        swap.state = data.state;
        updateStepProgress(2);
        setStatusMessage('pending', `BTC confirmed (${data.confirmations} conf). LP locking USDC + M1...`);
        btn.classList.add('hidden');
        DOM.depositBox.classList.add('hidden');

        if (data.btc_fund_txid) {
            showTxLink('btc', data.btc_fund_txid);
        }

        // autoPresign deferred to lp_locked state (user-commits-first model)
        // State polling will detect lp_locked and call autoPresign()

    } catch (e) {
        console.error('[pna] BTC funded error:', e);
        setStatusMessage('error', 'Error checking BTC: ' + e.message);
        btn.textContent = "I've sent BTC";
        btn.disabled = false;
    }
}

/**
 * Auto-send S_user to LP after LP has locked on-chain (lp_locked state).
 * LP uses all 3 secrets to claim BTC -> USDC auto-claims.
 */
async function autoPresign() {
    if (!State.currentSwap || !State.S_user) return;

    const swap = State.currentSwap;
    console.log('[pna] Sending S_user (presign)...');

    updateStepProgress(3);
    setStatusMessage('pending', 'Completing settlement...');

    try {
        const response = await fetch(`${getLpUrl()}/api/flowswap/${swap.swap_id}/presign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ S_user: State.S_user }),
        });

        if (!response.ok) {
            const error = await response.json();
            console.error('[pna] Presign failed:', error);
            // Don't show error to user — polling will catch state changes
            return;
        }

        const data = await response.json();
        console.log('[pna] Presign response:', data);

        swap.state = data.state;
        setStatusMessage('pending', 'BTC claimed. USDC being sent...');

        if (data.btc_claim_txid) {
            showTxLink('btc', data.btc_claim_txid);
        }

    } catch (e) {
        console.error('[pna] Presign error:', e);
    }
}

/**
 * Copy BTC deposit address to clipboard.
 */
function copyDepositAddress() {
    const address = DOM.depositAddress.textContent;
    const btn = DOM.depositBox.querySelector('.copy-btn');

    // Fallback for HTTP (no navigator.clipboard)
    const textarea = document.createElement('textarea');
    textarea.value = address;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);

    btn.classList.add('copied');
    btn.textContent = '\u2713';
    setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = '\u2398';
    }, 2000);
}

// =============================================================================
// RESET
// =============================================================================

function resetSwap() {
    State.currentSwap = null;
    State.S_user = null;
    State.activeLpUrl = null;
    State.inputAmount = 0;
    State.outputAmount = 0;

    DOM.inputAmount.value = '';
    DOM.outputAmount.textContent = '0.00';
    DOM.destAddress.value = '';


    DOM.swapModal.classList.add('hidden');
    DOM.newSwapBtn.classList.add('hidden');
    DOM.btcSentBtn.classList.add('hidden');
    DOM.depositBox.classList.add('hidden');
    DOM.txLinks.classList.add('hidden');
    DOM.txLinkBtc.classList.add('hidden');
    DOM.txLinkEvm.classList.add('hidden');

    document.querySelectorAll('.step').forEach(step => {
        step.classList.remove('active', 'completed');
    });

    DOM.swapBtn.classList.remove('loading');
    updateButtonState();

    if (State.statusInterval) {
        clearInterval(State.statusInterval);
        State.statusInterval = null;
    }
}

// =============================================================================
// SWAP EXPLORER
// =============================================================================

async function loadSwapExplorer() {
    const container = document.getElementById('explorer-list');
    if (!container) return;

    try {
        // Query all LPs and merge swap history
        const results = await Promise.allSettled(
            CONFIG.SDK_URLS.map(url =>
                fetch(`${url}/api/swaps?limit=10`, { signal: AbortSignal.timeout(15000) })
                    .then(r => r.ok ? r.json() : { swaps: [] })
            )
        );

        const allSwaps = results
            .filter(r => r.status === 'fulfilled' && r.value && r.value.swaps)
            .flatMap(r => r.value.swaps);

        // Deduplicate by swap_id, sort by created_at desc
        const seen = new Set();
        const data = { swaps: allSwaps.filter(s => {
            if (seen.has(s.swap_id)) return false;
            seen.add(s.swap_id);
            return true;
        }).sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 10) };

        if (!data.swaps || data.swaps.length === 0) {
            container.innerHTML = '<div class="explorer-empty">No swaps yet. Be the first!</div>';
            return;
        }

        container.innerHTML = data.swaps.map(swap => {
            const fromDisp = swap.from_display || `${(swap.from_amount || 0).toFixed(8)} ${swap.from_asset}`;
            const toDisp = swap.to_display || `${swap.to_amount} ${swap.to_asset}`;
            const rateDisp = swap.rate_display || '';
            const statusClass = getExplorerStatusClass(swap.status);
            const statusLabel = getExplorerStatusLabel(swap.status);
            const timeStr = swap.created_at ? formatExplorerTime(swap.created_at) : '-';
            const durationStr = swap.duration_seconds ? formatExplorerDuration(swap.duration_seconds) : '';

            // TX links
            const btcTxid = swap.btc_claim_txid || swap.btc_fund_txid || '';
            const evmTxhash = swap.evm_claim_txhash || '';

            return `
            <div class="explorer-item" onclick="toggleExplorerDetail(this)">
                <div class="explorer-row">
                    <div class="explorer-main">
                        <span class="explorer-id">${swap.swap_id.slice(0, 12)}...</span>
                        <span class="explorer-badge ${statusClass}">${statusLabel}</span>
                    </div>
                    <div class="explorer-time">${timeStr}</div>
                </div>
                <div class="explorer-amounts">
                    <span class="explorer-from">${fromDisp}</span>
                    <span class="explorer-arrow">\u2192</span>
                    <span class="explorer-to">${toDisp}</span>
                </div>
                <div class="explorer-detail hidden">
                    ${rateDisp ? `<div class="explorer-detail-row"><span>Rate</span><span>${rateDisp}</span></div>` : ''}
                    ${durationStr ? `<div class="explorer-detail-row"><span>Duration</span><span>${durationStr}</span></div>` : ''}
                    ${btcTxid ? `<div class="explorer-detail-row"><span>BTC TX</span><a href="https://mempool.space/signet/tx/${btcTxid}" target="_blank" rel="noopener">${btcTxid.slice(0, 16)}...</a></div>` : ''}
                    ${evmTxhash ? `<div class="explorer-detail-row"><span>USDC TX</span><a href="https://sepolia.basescan.org/tx/${evmTxhash}" target="_blank" rel="noopener">${evmTxhash.slice(0, 16)}...</a></div>` : ''}
                </div>
            </div>`;
        }).join('');

    } catch (e) {
        console.error('[pna] Explorer error:', e);
        container.innerHTML = '<div class="explorer-empty">Could not load swaps</div>';
    }
}

function toggleExplorerDetail(el) {
    const detail = el.querySelector('.explorer-detail');
    if (detail) detail.classList.toggle('hidden');
}

function getExplorerStatusClass(status) {
    if (status === 'claimed' || status === 'completed') return 'success';
    if (status === 'pending' || status === 'htlc_created') return 'pending';
    if (status === 'claiming') return 'active';
    if (status === 'expired' || status === 'refunded') return 'error';
    return 'pending';
}

function getExplorerStatusLabel(status) {
    const map = {
        'claimed': 'Completed',
        'completed': 'Completed',
        'pending': 'Pending',
        'htlc_created': 'HTLC Created',
        'claiming': 'Settling',
        'expired': 'Expired',
        'refunded': 'Refunded',
    };
    return map[status] || status;
}

function formatExplorerTime(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);

    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';

    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatExplorerDuration(sec) {
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + 'm ' + s + 's';
}

// Expose
window.toggleExplorerDetail = toggleExplorerDetail;

// =============================================================================
// UTILITIES
// =============================================================================

function formatNumber(num, decimals = 2) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(2) + 'M';
    }
    if (num >= 1000) {
        return num.toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }
    return num.toFixed(decimals);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

DOM.inputAmount.addEventListener('input', onInputChange);
DOM.destAddress.addEventListener('input', onAddressChange);
DOM.swapBtn.addEventListener('click', (e) => {
    if (DOM.swapBtn.disabled) {
        // Shake the button
        DOM.swapBtn.classList.add('shake');
        setTimeout(() => DOM.swapBtn.classList.remove('shake'), 400);

        // Highlight the missing field
        const hasAmount = State.inputAmount >= CONFIG.MIN_AMOUNT;
        const toAsset = ASSETS[State.toAsset];
        const hasAddress = toAsset.addressPattern.test(State.destAddress);

        if (!hasAmount) {
            DOM.inputAmount.classList.add('highlight-missing');
            DOM.inputAmount.focus();
            setTimeout(() => DOM.inputAmount.classList.remove('highlight-missing'), 2000);
        } else if (!hasAddress) {
            DOM.destAddress.classList.add('highlight-missing');
            DOM.destAddress.focus();
            setTimeout(() => DOM.destAddress.classList.remove('highlight-missing'), 2000);
        }
        return;
    }
    initiateSwap();
});
DOM.newSwapBtn.addEventListener('click', resetSwap);

// Close modal on backdrop click
DOM.assetModal?.querySelector('.modal-backdrop')?.addEventListener('click', closeAssetModal);

// Close modals on escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (!DOM.assetModal.classList.contains('hidden')) {
            closeAssetModal();
        } else if (!DOM.swapModal.classList.contains('hidden')) {
            closeSwapModal();
        }
    }
});

// Smooth scroll to "how it works"
document.querySelector('.learn-more')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('how-it-works').scrollIntoView({ behavior: 'smooth' });
});

// Expose functions for inline onclick handlers
window.openAssetModal = openAssetModal;
window.closeAssetModal = closeAssetModal;
window.closeSwapModal = closeSwapModal;
window.selectAsset = selectAsset;
window.swapDirection = swapDirection;
window.resetSwap = resetSwap;
window.notifyBtcFunded = notifyBtcFunded;
window.copyDepositAddress = copyDepositAddress;

// =============================================================================
// INITIALIZATION
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    console.log('[pna] Initializing FlowSwap 3S...');

    // Show loading state
    DOM.rateValue.textContent = 'Loading...';

    // Fetch LP info from SDK
    await fetchLPInfo();

    // Update display
    updateAssetDisplay();
    await updateRateDisplay();
    updateButtonState();

    // Load swap explorer
    await loadSwapExplorer();

    // Refresh rates periodically (pause during active swap)
    setInterval(async () => {
        if (State.currentSwap) return;
        if (State.inputAmount > 0) {
            await onInputChange();
        } else {
            await updateRateDisplay();
        }
    }, CONFIG.QUOTE_REFRESH_MS);

    // Refresh explorer every 30s
    setInterval(loadSwapExplorer, 30000);

    console.log('[pna] Ready - FlowSwap 3S - Connected to', currentLP.name);
});
