/* ==========================================================
   VicDex — app.js (ethers v6)
   - Mobile nav fallback (MetaMask Mobile)
   - Live quote "To amount" when typing "From"
   - Pool reserves + explorer link
   - One-tap Supply (auto-approve nếu cần)
   - Robust createPool (estimateGas + staticCall)
   - FIX (Mobile): Chuẩn hoá thập phân (, → .) để ô "To" tự nhảy
   ========================================================== */
(() => {
  'use strict';
  const { ethers } = window;

  /* -------------------------- Utils -------------------------- */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const nowYear = () => new Date().getFullYear();
  const fmt = (n, d=6) => Number(n||0).toLocaleString(undefined,{maximumFractionDigits:d});
  const toWei = (v) => ethers.parseUnits(String(v||"0"), 18);
  const fromWei = (b) => Number(ethers.formatUnits(b??0n, 18));
  const short = (a) => { try{a=ethers.getAddress(a);}catch{} return a?`${a.slice(0,6)}…${a.slice(-4)}`:""; };
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const debounce = (fn,ms=240)=>{let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}};
  const isAddr = (s)=>{ try{ return ethers.isAddress((s||"").trim()); }catch{ return false; } };
  const errMsg = (e)=> e?.reason || e?.shortMessage || e?.message || String(e);

  // (FIX Mobile) Chuẩn hoá chuỗi số thập phân và parse an toàn
  function parseDec(inputElOrStr){
    const raw = (typeof inputElOrStr === "string" ? inputElOrStr : (inputElOrStr?.value||"")).trim();
    if (!raw) return NaN;
    const norm = raw.replace(/,/g, ".").replace(/\s+/g, ""); // "10,5" -> "10.5"
    if (!/^\d*\.?\d*$/.test(norm)) return NaN;              // chỉ cho phép số và 1 dấu '.'
    const v = Number(norm);
    return Number.isFinite(v) ? v : NaN;
  }

  function toast(msg, kind="ok"){
    const box = $("#toast");
    if(!box){ console.log(`[${kind}]`, msg); return; }
    box.textContent = msg;
    box.className = `toast show ${kind}`;
    setTimeout(()=> box.className="toast", 3400);
  }

  /* --------------------- Config from meta --------------------- */
  const meta = (n)=>document.querySelector(`meta[name="${n}"]`)?.content?.trim()||"";
  const FACTORY_ADDR = meta("vicdex-factory-address");
  const RPC_URL      = meta("vicdex-rpc") || "https://rpc.viction.xyz";
  const CHAIN_ID_NUM = Number(meta("vicdex-chain-id") || 88);
  const CHAIN_ID_HEX = "0x"+CHAIN_ID_NUM.toString(16);
  const GUIDE_LINK   = meta("vicdex-guide-link");

  /* -------------------------- Const -------------------------- */
  const SLIPPAGE_BPS = 100n;   // 1.00%
  const BPS_DEN      = 10_000n;
  const DEFAULT_CREATEPOOL_FEE_BPS = 30; // 0.30%

  /* --------------------------- ABIs -------------------------- */
  // Factory (VicPoolFactory)
  const FACTORY_ABI = [
    {"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"token","type":"address"},{"indexed":false,"internalType":"address","name":"pool","type":"address"},{"indexed":false,"internalType":"uint16","name":"feeBps","type":"uint16"}],"name":"PoolCreated","type":"event"},
    {"inputs":[{"internalType":"contract IERC20","name":"token","type":"address"},{"internalType":"uint16","name":"feeBps","type":"uint16"}],"name":"createPool","outputs":[{"internalType":"address","name":"pool","type":"address"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"getPool","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"allPools","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"allPoolsLength","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
  ];
  // Pool (VicPool)
  const POOL_ABI = [
    {"inputs":[],"name":"feeBps","outputs":[{"internalType":"uint16","name":"","type":"uint16"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"token","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"getReserves","outputs":[{"internalType":"uint256","name":"vic","type":"uint256"},{"internalType":"uint256","name":"tok","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"reserveIn","type":"uint256"},{"internalType":"uint256","name":"reserveOut","type":"uint256"}],"name":"getAmountOut","outputs":[{"internalType":"uint256","name":"amountOut","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"tokenDesired","type":"uint256"},{"internalType":"uint256","name":"minToken","type":"uint256"},{"internalType":"uint256","name":"minVIC","type":"uint256"}],"name":"addLiquidity","outputs":[{"internalType":"uint256","name":"liquidity","type":"uint256"},{"internalType":"uint256","name":"tokenIn","type":"uint256"},{"internalType":"uint256","name":"vicIn","type":"uint256"}],"stateMutability":"payable","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"liquidity","type":"uint256"},{"internalType":"uint256","name":"minTokenOut","type":"uint256"},{"internalType":"uint256","name":"minVICOut","type":"uint256"}],"name":"removeLiquidity","outputs":[{"internalType":"uint256","name":"vicOut","type":"uint256"},{"internalType":"uint256","name":"tokenOut","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"minTokensOut","type":"uint256"},{"internalType":"address","name":"to","type":"address"}],"name":"swapExactVICForTokens","outputs":[{"internalType":"uint256","name":"tokensOut","type":"uint256"}],"stateMutability":"payable","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"tokenIn","type":"uint256"},{"internalType":"uint256","name":"minVICOut","type":"uint256"},{"internalType":"address","name":"to","type":"address"}],"name":"swapExactTokensForVIC","outputs":[{"internalType":"uint256","name":"vicOut","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"totalSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
  ];
  const ERC20_ABI = [
    {"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"symbol","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"value","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
  ];

  /* -------------------- Providers / Contracts -------------------- */
  const readProvider = new ethers.JsonRpcProvider(RPC_URL);
  let browserProvider = null, signer = null;
  const factoryRO = new ethers.Contract(FACTORY_ADDR, FACTORY_ABI, readProvider);

  const factory = ()=> new ethers.Contract(FACTORY_ADDR, FACTORY_ABI, signer||readProvider);
  const poolAt  = (addr, ro=false)=> new ethers.Contract(addr, POOL_ABI, (ro||!signer)?readProvider:signer);
  const erc20   = (addr, ro=false)=> new ethers.Contract(addr, ERC20_ABI, (ro||!signer)?readProvider:signer);

  async function gas(limit){
    const gl = BigInt(limit);
    const fee = await (signer?.provider||readProvider).getFeeData();
    if (fee.maxFeePerGas!=null) return { gasLimit: gl, maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };
    return { gasLimit: gl, gasPrice: 5_000_000_000n };
  }

  /* ---------------------------- DOM ---------------------------- */
  const $connectBtn = $("#connectBtn");
  const $switchNet  = $("#switchNetworkBtn");
  const $networkBadge = $("#networkBadge");
  const $year = $("#year"); if($year) $year.textContent = nowYear();
  const $guideFoot = $("#guideLinkFoot"); if($guideFoot && GUIDE_LINK){ $guideFoot.href = GUIDE_LINK; $guideFoot.style.display="inline"; }

  // Swap IDs
  const $swapFromBtn=$("#swap_from_token_btn"), $swapToBtn=$("#swap_to_token_btn");
  const $swapFromSym=$("#swap_from_symbol"), $swapToSym=$("#swap_to_symbol");
  const $swapFromAmt=$("#swap_from_amount"), $swapToAmt=$("#swap_to_amount");
  const $swapFlip=$("#swap_flip_btn"), $swQuote=$("#sw_quoteBtn"), $swExec=$("#swap_execute_btn"), $swStatus=$("#sw_status");
  const $pickerFrom=$("#picker_from"), $pickerFromList=$("#picker_from_list"), $pickerFromSearch=$("#picker_from_search");
  const $pickerTo=$("#picker_to"), $pickerToList=$("#picker_to_list"), $pickerToSearch=$("#picker_to_search");

  // Liquidity IDs
  const $liqTokBtn=$("#liq_token_btn"), $liqTokSym=$("#liq_token_symbol");
  const $liqVicAmt=$("#liq_vic_amount"), $liqTokAmt=$("#liq_token_amount");
  const $liqApprove=$("#liq_approve_btn"), $liqSupply=$("#liq_supply_btn"), $liqStatus=$("#liq_status");
  const $pickerLiq=$("#picker_liq"), $pickerLiqList=$("#picker_liq_list"), $pickerLiqSearch=$("#picker_liq_search");

  // Pools/positions
  const $poolsList=$("#pools_list"), $positionsList=$("#positions_list");

  // Views
  const sectionIds=["swap","liquidity","pools"];
  const syncView=()=>{ const cur=(location.hash||"#swap").slice(1); sectionIds.forEach(id=>{const el=$("#"+id); if(el) el.style.display=(id===cur)?"block":"none";}); };
  window.addEventListener("hashchange", syncView);
  window.addEventListener("load", syncView);

  /* --------------------- Wallet / Network --------------------- */
  async function ensureViction(){
    if(!window.ethereum) return false;
    const prov = new ethers.BrowserProvider(window.ethereum, "any");
    const net = await prov.getNetwork();
    if(Number(net.chainId)===CHAIN_ID_NUM) return true;
    try{
      await prov.send("wallet_switchEthereumChain", [{ chainId: CHAIN_ID_HEX }]);
      return true;
    }catch(err){
      if(err?.code===4902){
        await prov.send("wallet_addEthereumChain", [{
          chainId: CHAIN_ID_HEX,
          chainName: "Viction Mainnet",
          nativeCurrency: { name:"VIC", symbol:"VIC", decimals:18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: ["https://vicscan.xyz/"]
        }]);
        return true;
      }
      return false;
    }
  }

  async function connect(){
    if(!window.ethereum) return toast("No wallet found.","warn");
    try{
      browserProvider = new ethers.BrowserProvider(window.ethereum, "any");
      await browserProvider.send("eth_requestAccounts", []);
      signer = await browserProvider.getSigner();
      const ok = await ensureViction();
      if(!ok) return toast("Please switch to Viction.","warn");
      const addr = await signer.getAddress();
      $connectBtn?.classList.add("connected");
      if($connectBtn) $connectBtn.textContent = short(addr);
      if($networkBadge) $networkBadge.textContent = `Viction · Chain ${CHAIN_ID_NUM}`;

      window.ethereum?.on?.("accountsChanged", ()=> location.reload());
      window.ethereum?.on?.("chainChanged", ()=> location.reload());

      attachHandlers();
      await refreshRegistry();
      renderAllPickers();
      attachLiquiditySync();
      await refreshBalances();
      await renderPositions();
      await renderPoolsList();
      toast("Wallet connected.");
    }catch(e){ console.error(e); toast("Wallet connection failed.","err"); }
  }
  $connectBtn?.addEventListener("click", connect);
  $switchNet?.addEventListener("click", async()=>{ const ok=await ensureViction(); toast(ok?"Switched to Viction.":"Switch failed.","warn"); });

  /* ------------------ Registry (Token↔Pool) ------------------ */
  const TOKENS = new Map(); // key: tokenAddr.lower → {address,symbol,decimals,pool,feeBps,reserves}
  const VIC = { address:"VIC", symbol:"VIC", decimals:18, pool:null };
  let fromToken = VIC, toToken = null, liqToken = null;

  async function getDecimals(addr){ try{ return await erc20(addr,true).decimals(); }catch{ return 18; } }
  async function getSymbol(addr){ try{ return await erc20(addr,true).symbol(); }catch{ return "TOKEN"; } }

  async function refreshRegistry(){
    TOKENS.clear();
    try{
      const len = Number(await factoryRO.allPoolsLength());
      for(let i=0;i<len;i++){
        const p = await factoryRO.allPools(i);
        const pr = poolAt(p, true);
        const tokenAddr = await pr.token();
        const [sym, dec, fee, reserves] = await Promise.all([
          getSymbol(tokenAddr),
          getDecimals(tokenAddr),
          pr.feeBps(),
          pr.getReserves()
        ]);
        TOKENS.set(tokenAddr.toLowerCase(), {
          address: tokenAddr, symbol: sym||"TOKEN", decimals: dec||18,
          pool: p, feeBps: Number(fee), reserves
        });
      }
    }catch(e){ console.warn("refreshRegistry failed:", e); }
  }

  const tokensSorted = ()=> {
    const arr=[...TOKENS.values()];
    arr.sort((a,b)=> a.symbol.localeCompare(b.symbol));
    return arr;
  };

  async function upsertTokenByAddress(addr){
    const a = ethers.getAddress(addr);
    const key = a.toLowerCase();
    if (TOKENS.has(key)) return TOKENS.get(key);
    let sym="TOKEN", dec=18, poolAddr=ethers.ZeroAddress, fee=0, reserves={vic:0n,tok:0n};
    try{
      const c=erc20(a,true);
      sym = await c.symbol().catch(()=> "TOKEN");
      dec = await c.decimals().catch(()=> 18);
      poolAddr = await factoryRO.getPool(a);
      if (poolAddr && poolAddr !== ethers.ZeroAddress){
        const p=poolAt(poolAddr,true);
        try{ reserves = await p.getReserves(); fee = Number(await p.feeBps()); }catch{}
      }
    }catch{}
    const info = { address:a, symbol:sym, decimals:dec, pool:poolAddr, feeBps:fee, reserves };
    TOKENS.set(key, info);
    return info;
  }

  /* ----------------------- Pickers & Search ----------------------- */
  function openPicker(p){ p?.classList.remove("hide"); }
  function closePicker(p){ p?.classList.add("hide"); }

  function renderPickerList(ul, items, onChoose, allowVIC){
    if(!ul) return;
    ul.innerHTML = "";
    if(allowVIC){
      const li=document.createElement("li");
      li.className="picker-item";
      li.innerHTML=`<div class="left"><span class="dot"></span><strong>VIC</strong></div><span class="muted">Native</span>`;
      li.onclick=()=>{ onChoose(null); closePicker(ul.closest(".picker")); };
      ul.appendChild(li);
    }
    items.forEach(t=>{
      const li=document.createElement("li");
      li.className="picker-item";
      li.innerHTML=`
        <div class="left">
          <span class="dot"></span>
          <div class="info">
            <strong>${t.symbol}</strong>
            <div class="muted">${short(t.address)}</div>
          </div>
        </div>
        <span class="muted">${t.feeBps? `${t.feeBps} bps` : (t.pool && t.pool!==ethers.ZeroAddress ? '— bps' : '')}</span>
      `;
      li.onclick=()=>{ onChoose(t); closePicker(ul.closest(".picker")); };
      ul.appendChild(li);
    });
    if (!items.length){
      const li=document.createElement("li");
      li.className="picker-item";
      li.innerHTML=`<div class="left"><div class="info"><strong>No results</strong></div></div>`;
      ul.appendChild(li);
    }
  }

  function renderAllPickers(){
    const list = tokensSorted();
    // Swap FROM
    renderPickerList($pickerFromList, list, (item)=>{
      fromToken = item||VIC; if($swapFromSym) $swapFromSym.textContent=fromToken.symbol;
      if(toToken && fromToken && toToken.address!=="VIC" && toToken.address===fromToken.address){
        toToken=null; if($swapToSym)$swapToSym.textContent="Select token";
      }
      onQuote(); refreshBalances();
    }, true);
    // Swap TO
    renderPickerList($pickerToList, list, (item)=>{
      toToken = item||VIC; if($swapToSym)$swapToSym.textContent=toToken.symbol;
      if(fromToken && toToken && fromToken.address!=="VIC" && toToken.address===fromToken.address){
        fromToken=VIC; if($swapFromSym)$swapFromSym.textContent="VIC";
      }
      onQuote(); refreshBalances();
    }, true);
    // Liquidity token
    renderPickerList($pickerLiqList, list.filter(t=>t.address!=="VIC"), (item)=>{
      liqToken=item||null; if($liqTokSym)$liqTokSym.textContent=liqToken?liqToken.symbol:"Select token";
      attachLiquiditySync(); refreshBalances();
    }, false);
    // default TO suggestion
    if(!toToken){
      const first = list.find(t=>t.address!=="VIC");
      if(first){ toToken=first; if($swapToSym)$swapToSym.textContent=first.symbol; }
    }
  }

  function attachPickerSearch(inputEl, listEl, onChoose, allowVIC){
    if(!inputEl || !listEl) return;
    const run = debounce(async ()=>{
      const q = inputEl.value.trim();
      if (isAddr(q)){ // pasted address
        try{
          const info = await upsertTokenByAddress(q);
          renderAllPickers();
          onChoose(info);
          inputEl.value="";
          return;
        }catch(e){ console.warn("address add failed", e); toast("Invalid token address","warn"); }
      }
      const all = tokensSorted().filter(t=>{
        if (!q) return true;
        const s = q.toLowerCase();
        return (t.symbol||"").toLowerCase().includes(s) || (t.address||"").toLowerCase().includes(s);
      });
      renderPickerList(listEl, all, onChoose, allowVIC);
    }, 160);
    inputEl.addEventListener("input", run);
    inputEl.addEventListener("paste", ()=> setTimeout(run, 0));
    inputEl.addEventListener("keydown",(e)=>{ if(e.key==="Enter") run(); });
  }

  /* Attach search handlers */
  attachPickerSearch($pickerFromSearch, $pickerFromList, (item)=>{
    fromToken = item||VIC; if($swapFromSym)$swapFromSym.textContent=fromToken.symbol; onQuote(); refreshBalances();
    closePicker($pickerFrom);
  }, true);
  attachPickerSearch($pickerToSearch, $pickerToList, (item)=>{
    toToken = item||VIC; if($swapToSym)$swapToSym.textContent=toToken.symbol; onQuote(); refreshBalances();
    closePicker($pickerTo);
  }, true);
  attachPickerSearch($pickerLiqSearch, $pickerLiqList, (item)=>{
    liqToken = item||null; if($liqTokSym)$liqTokSym.textContent=liqToken?liqToken.symbol:"Select token";
    attachLiquiditySync(); refreshBalances();
    closePicker($pickerLiq);
  }, false);

  /* ---------------------- Balances helpers ---------------------- */
  function ensureAfter(input,id){
    if(!input) return null;
    let el=$("#"+id); if(el) return el;
    el=document.createElement("div"); el.id=id; el.className="muted mini"; el.style.marginTop="6px";
    input.insertAdjacentElement("afterend", el); return el;
  }
  const $balSwapFrom=ensureAfter($swapFromAmt,"swap_from_balance");
  const $balSwapTo  =ensureAfter($swapToAmt,"swap_to_balance");
  const $balLiqVic  =ensureAfter($liqVicAmt,"liq_vic_balance");
  const $balLiqTok  =ensureAfter($liqTokAmt,"liq_tok_balance");

  async function refreshBalances(){
    if(!signer){ [$balSwapFrom,$balSwapTo,$balLiqVic,$balLiqTok].forEach(el=>el&&(el.textContent="")); return; }
    const addr=await signer.getAddress();
    try{
      const vicBal = await signer.provider.getBalance(addr);
      if($balSwapFrom && fromToken.address==="VIC") $balSwapFrom.textContent=`Balance: ${fmt(fromWei(vicBal))} VIC`;
      if($balSwapTo   && toToken?.address==="VIC") $balSwapTo.textContent  =`Balance: ${fmt(fromWei(vicBal))} VIC`;
      if($balLiqVic) $balLiqVic.textContent=`Balance: ${fmt(fromWei(vicBal))} VIC`;
    }catch{}
    try{
      if(fromToken.address!=="VIC"){
        const c=erc20(fromToken.address,true), b=await c.balanceOf(addr);
        const dec=fromToken.decimals??await getDecimals(fromToken.address);
        $balSwapFrom && ($balSwapFrom.textContent=`Balance: ${fmt(Number(ethers.formatUnits(b,dec)))} ${fromToken.symbol}`);
      }
    }catch{}
    try{
      if(toToken?.address!=="VIC"){
        const c=erc20(toToken.address,true), b=await c.balanceOf(addr);
        const dec=toToken.decimals??await getDecimals(toToken.address);
        $balSwapTo && ($balSwapTo.textContent=`Balance: ${fmt(Number(ethers.formatUnits(b,dec)))} ${toToken.symbol}`);
      }
    }catch{}
    try{
      if(liqToken){
        const c=erc20(liqToken.address,true), b=await c.balanceOf(addr);
        const dec=liqToken.decimals??await getDecimals(liqToken.address);
        $balLiqTok && ($balLiqTok.textContent=`Balance: ${fmt(Number(ethers.formatUnits(b,dec)))} ${liqToken.symbol}`);
      }else{ $balLiqTok && ($balLiqTok.textContent=""); }
    }catch{}
  }

  /* -------------------------- Actions -------------------------- */
  function attachHandlers(){
    // Swap
    $swapFromBtn?.addEventListener("click", ()=> openPicker($pickerFrom));
    $swapToBtn  ?.addEventListener("click", ()=> openPicker($pickerTo));
    $swapFlip   ?.addEventListener("click", onFlip);
    $swQuote    ?.addEventListener("click", onQuote);
    // Live quote mượt trên mobile
    const reQuote = debounce(onQuote, 120);
    $swapFromAmt?.addEventListener("input", reQuote);
    $swapFromAmt?.addEventListener("keyup", reQuote);
    $swapFromAmt?.addEventListener("change", onQuote);
    $swExec     ?.addEventListener("click", onSwap);
    // Liquidity
    $liqTokBtn  ?.addEventListener("click", ()=> openPicker($pickerLiq));
    $liqApprove ?.addEventListener("click", onApproveLiq);
    $liqSupply  ?.addEventListener("click", onOneTapSupply);
    // Close pickers on overlay click
    $$(".picker").forEach(p=> p.addEventListener("click",(e)=>{ if(e.target===p) closePicker(p); }));
    $$(".picker-close").forEach(btn=> addClose(btn));
  }

  function addClose(btn){
    btn.addEventListener("click",(e)=> {
      const sel = e.currentTarget.getAttribute("data-close");
      (sel?$(sel):e.currentTarget.closest(".picker"))?.classList.add("hide");
    });
  }

  /* ---------------------- Mobile nav fallback ---------------------- */
  function mobileNavFallback(){
    const burger = document.querySelector(".burger");
    const cb = document.querySelector("#navToggle");
    const closeNav = ()=>{
      document.body.classList.remove("nav-open");
      if (cb) cb.checked = false;
    };
    if (!burger) return;
    burger.addEventListener("click", (e)=>{
      e.preventDefault();
      const open = !document.body.classList.contains("nav-open");
      document.body.classList.toggle("nav-open", open);
      if (cb) cb.checked = open;
    }, true);
    document.querySelectorAll(".top-nav a").forEach(a=> a.addEventListener("click", closeNav));
    document.addEventListener("click", (e)=>{
      if (!document.body.classList.contains("nav-open")) return;
      if (!e.target.closest(".top-nav") && !e.target.closest(".burger")) closeNav();
    });
  }

  /* ---------------------------- Swap ---------------------------- */
  async function onFlip(){
    if(!toToken) return;
    const tmp = fromToken;
    fromToken = (toToken.address==="VIC")?{...VIC}:toToken;
    toToken   = (tmp.address==="VIC")?null:tmp;
    if($swapFromSym) $swapFromSym.textContent = fromToken.symbol;
    if($swapToSym)   $swapToSym.textContent   = toToken?toToken.symbol:"Select token";
    $swapToAmt && ($swapToAmt.value="");
    await onQuote(); refreshBalances();
  }

  async function poolForToken(tokenSide){
    return await factory().getPool(tokenSide.address);
  }

  async function onQuote(){
    try{
      $swStatus && ($swStatus.textContent="");
      $swapToAmt && ($swapToAmt.value="");

      // (FIX) Nhắc chọn token "To"
      if(!toToken){ $swStatus && ($swStatus.textContent="Please select the ‘To’ token."); return; }

      // (FIX Mobile) Dùng parseDec thay cho Number
      const amtIn = parseDec($swapFromAmt);
      if(!(amtIn>0)) return;

      const tokenSide = (fromToken.address==="VIC")?toToken:fromToken;
      const dec = tokenSide.decimals ?? await getDecimals(tokenSide.address);
      const poolAddr = await poolForToken(tokenSide);
      if(!poolAddr || poolAddr===ethers.ZeroAddress){ $swStatus && ($swStatus.textContent="Pool not found"); return; }
      const p = poolAt(poolAddr,true);
      const { vic, tok } = await p.getReserves();

      let outBN, outNum;
      if(fromToken.address==="VIC"){
        outBN = await p.getAmountOut(toWei(amtIn), vic, tok);
        outNum = Number(ethers.formatUnits(outBN, dec));
      }else{
        outBN = await p.getAmountOut(ethers.parseUnits(String(amtIn), dec), tok, vic);
        outNum = fromWei(outBN);
      }
      $swapToAmt && ($swapToAmt.value = fmt(outNum));
      $swStatus && ($swStatus.textContent = `Pool ${short(poolAddr)} · Est. out ≈ ${fmt(outNum)}`);
    }catch(e){ console.error(e); $swStatus && ($swStatus.textContent=errMsg(e)); }
  }

  async function onSwap(){
    if(!signer) return toast("Connect wallet first.","warn");
    const ok = await ensureViction(); if(!ok) return toast("Switch to Viction.","warn");
    try{
      if(!toToken) return toast("Select token.","warn");
      const owner = await signer.getAddress();
      const tokenSide = (fromToken.address==="VIC")?toToken:fromToken;
      const dec = tokenSide.decimals ?? await getDecimals(tokenSide.address);
      const poolAddr = await poolForToken(tokenSide);
      if(!poolAddr || poolAddr===ethers.ZeroAddress) return toast("Pool not found.","err");
      const p = poolAt(poolAddr);

      // (FIX Mobile) Dùng parseDec để không dính NaN từ "10,5"
      const amtInNum = parseDec($swapFromAmt);
      if(!(amtInNum>0)) return toast("Enter amount.","warn");

      const { vic, tok } = await p.getReserves();
      let inBN, outBN;
      if(fromToken.address==="VIC"){
        inBN=toWei(amtInNum); outBN=await p.getAmountOut(inBN, vic, tok);
        const minOut = (outBN*(BPS_DEN-SLIPPAGE_BPS))/BPS_DEN;
        const tx = await p.swapExactVICForTokens(minOut, owner, { ...(await gas(2_000_000)), value: inBN });
        await tx.wait();
      }else{
        inBN=ethers.parseUnits(String(amtInNum), dec); outBN=await p.getAmountOut(inBN, tok, vic);
        const minVic = (outBN*(BPS_DEN-SLIPPAGE_BPS))/BPS_DEN;
        const c = erc20(tokenSide.address);
        const cur = await c.allowance(owner, poolAddr);
        if(cur < inBN){ const tx0 = await c.approve(poolAddr, inBN, await gas(200_000)); await tx0.wait(); }
        const tx = await p.swapExactTokensForVIC(inBN, minVic, owner, await gas(2_000_000));
        await tx.wait();
      }
      toast("Swap success.");
      $swapToAmt && ($swapToAmt.value="");
      await refreshBalances();
      await renderPositions();
    }catch(e){ console.error(e); toast(errMsg(e),"err"); }
  }

  /* ----------------------- Liquidity sync ----------------------- */
  function attachLiquiditySync(){
    if(!$liqVicAmt || !$liqTokAmt || !liqToken) return;
    const onVic = debounce(async()=>{
      try{
        const v = Number($liqVicAmt.value||"0"); if(v<=0) return;
        const poolAddr = await factory().getPool(liqToken.address);
        if(!poolAddr || poolAddr===ethers.ZeroAddress) return; // new pool: no ratio
        const p = poolAt(poolAddr,true);
        const { vic, tok } = await p.getReserves();
        if(vic>0n && tok>0n){
          const needTok = (toWei(v) * tok) / vic;
          const needTokNum = Number(ethers.formatUnits(needTok, liqToken.decimals??18));
          if(!$liqTokAmt.matches(":focus")) $liqTokAmt.value = String(needTokNum);
        }
      }catch{}
    },170);

    const onTok = debounce(async()=>{
      try{
        const t = Number($liqTokAmt.value||"0"); if(t<=0) return;
        const poolAddr = await factory().getPool(liqToken.address);
        if(!poolAddr || poolAddr===ethers.ZeroAddress) return;
        const p = poolAt(poolAddr,true);
        const { vic, tok } = await p.getReserves();
        if(vic>0n && tok>0n){
          const inTok = ethers.parseUnits(String(t), liqToken.decimals??18);
          const needVic = (inTok * vic) / tok;
          const needVicNum = fromWei(needVic);
          if(!$liqVicAmt.matches(":focus")) $liqVicAmt.value = String(needVicNum);
        }
      }catch{}
    },170);

    $liqVicAmt._vic && $liqVicAmt.removeEventListener("input", $liqVicAmt._vic);
    $liqTokAmt._tok && $liqTokAmt.removeEventListener("input", $liqTokAmt._tok);
    $liqVicAmt._vic = onVic; $liqTokAmt._tok = onTok;
    $liqVicAmt.addEventListener("input", onVic);
    $liqTokAmt.addEventListener("input", onTok);
  }

  /* ===================== FIX: createPool chắc chắn ===================== */
  async function ensurePoolExists(tokenAddr){
    if(!tokenAddr || !isAddr(tokenAddr)) throw new Error("Invalid token address.");
    const a = ethers.getAddress(tokenAddr);
    const fac = factory();

    // (0) token must be a contract
    const tokenCode = await readProvider.getCode(a);
    if(!tokenCode || tokenCode === "0x") throw new Error("Address has no contract code (not a token).");

    // (1) exists?
    let existing = await fac.getPool(a);
    if (existing && existing !== ethers.ZeroAddress){
      const code = await readProvider.getCode(existing);
      if (code && code !== "0x") return existing;
    }

    // (2) estimateGas → predict revert & gas
    let estGas;
    try{
      estGas = await fac.createPool.estimateGas(a, DEFAULT_CREATEPOOL_FEE_BPS);
    }catch(e){
      const re = await factoryRO.getPool(a);
      if(re && re!==ethers.ZeroAddress) return re;
      throw new Error("createPool pre-check failed: "+ errMsg(e));
    }

    // (3) simulate
    try{
      await fac.createPool.staticCall(a, DEFAULT_CREATEPOOL_FEE_BPS);
    }catch(e){
      const re = await factoryRO.getPool(a);
      if(re && re!==ethers.ZeroAddress) return re;
      throw new Error("createPool simulation failed: "+ errMsg(e));
    }

    // (4) send tx with padded gas
    const padded = ((estGas*120n)/100n) + 200_000n;
    const gasLimit = padded < 3_000_000n ? 3_000_000n : padded;

    $liqStatus && ($liqStatus.textContent = "Creating pool (30 bps)...");
    const tx = await fac.createPool(a, DEFAULT_CREATEPOOL_FEE_BPS, await gas(gasLimit));
    await tx.wait();

    await sleep(800);
    const addr = await factoryRO.getPool(a);
    await refreshRegistry(); renderAllPickers();
    if(!addr || addr===ethers.ZeroAddress) throw new Error("Create pool failed (not indexed).");
    return addr;
  }

  // Approve riêng (tuỳ chọn)
  async function onApproveLiq(){
    if(!signer) return toast("Connect wallet first.","warn");
    if(!liqToken) return toast("Select token.","warn");
    try{
      const poolAddr = await ensurePoolExists(liqToken.address);
      const owner=await signer.getAddress();
      const inTokNum = Number($liqTokAmt?.value||"0"); if(inTokNum<=0) return toast("Enter token amount.","warn");
      const dec = liqToken.decimals ?? await getDecimals(liqToken.address);
      const inTokBN = ethers.parseUnits(String(inTokNum), dec);
      const c = erc20(liqToken.address);
      const cur = await c.allowance(owner, poolAddr);
      if(cur >= inTokBN){ toast("Already approved."); return; }
      const tx0 = await c.approve(poolAddr, inTokBN, await gas(200_000)); await tx0.wait();
      toast("Approved.");
      await refreshBalances();
    }catch(e){ console.error(e); const msg=errMsg(e); $liqStatus && ($liqStatus.textContent=msg); toast(msg,"err"); }
  }

  // ONE-TAP SUPPLY: auto approve if needed
  async function onOneTapSupply(){
    if(!signer) return toast("Connect wallet first.","warn");
    if(!liqToken) return toast("Select token.","warn");
    try{
      const poolAddr = await ensurePoolExists(liqToken.address);
      const owner = await signer.getAddress();
      const vicAmtNum = Number($liqVicAmt?.value||"0");
      const tokAmtNum = Number($liqTokAmt?.value||"0");
      if(vicAmtNum<=0 || tokAmtNum<=0) return toast("Enter both amounts.","warn");

      const dec = liqToken.decimals ?? await getDecimals(liqToken.address);
      const vicIn = toWei(vicAmtNum);
      const tokIn = ethers.parseUnits(String(tokAmtNum), dec);

      // auto-approve nếu chưa đủ allowance
      const c = erc20(liqToken.address);
      const cur = await c.allowance(owner, poolAddr);
      if(cur < tokIn){
        toast("Approving token…");
        const tx0 = await c.approve(poolAddr, tokIn, await gas(200_000));
        await tx0.wait();
        await sleep(300);
      }

      const minTok = (tokIn*(BPS_DEN-SLIPPAGE_BPS))/BPS_DEN;
      const minVic = (vicIn*(BPS_DEN-SLIPPAGE_BPS))/BPS_DEN;

      toast("Supplying…");
      const p = poolAt(poolAddr);
      const tx = await p.addLiquidity(tokIn, minTok, minVic, { ...(await gas(2_000_000)), value: vicIn });
      await tx.wait();

      toast("Supplied liquidity.");
      $liqVicAmt && ($liqVicAmt.value="");
      $liqTokAmt && ($liqTokAmt.value="");
      await refreshBalances();
      await renderPositions();
      await renderPoolsList();
    }catch(e){ console.error(e); const msg=errMsg(e); $liqStatus && ($liqStatus.textContent=msg); toast(msg,"err"); }
  }

  /* ----------------------- Remove Liquidity ----------------------- */
  async function onRemove(liq, poolAddr){
    try{
      const p = poolAt(poolAddr);
      const minTokOut = 0n, minVicOut = 0n; // Simple UX (no slippage on burn)
      const tx = await p.removeLiquidity(liq, minTokOut, minVicOut, await gas(1_200_000));
      await tx.wait();
      toast("Removed liquidity.");
      await refreshBalances();
      await renderPositions();
      await renderPoolsList();
    }catch(e){ console.error(e); toast(errMsg(e),"err"); }
  }

  /* --------------------- Render Pools / Positions --------------------- */
  async function renderPoolsList(){
    if(!$poolsList) return;
    $poolsList.innerHTML = "";
    const items = tokensSorted();

    for(const t of items){
      let poolAddr = t.pool;
      let vic=0n, tok=0n, fee=t.feeBps||0;
      try{
        if (poolAddr && poolAddr!==ethers.ZeroAddress){
          const p = poolAt(poolAddr,true);
          const r = await p.getReserves();
          vic = r.vic; tok = r.tok;
          if(!t.feeBps){ try{ fee = Number(await p.feeBps()); }catch{} }
        } else {
          poolAddr = null;
        }
      }catch{}

      const row = document.createElement("div");
      row.className = "pool-row";

      const vicNum = fmt(fromWei(vic));
      const tokNum = fmt(Number(ethers.formatUnits(tok, t.decimals||18)));
      const tvlTxt = poolAddr ? `${vicNum} VIC / ${tokNum} ${t.symbol}` : "—";
      const href = poolAddr ? `https://vicscan.xyz/address/${poolAddr}` : "#";

      row.innerHTML = `
        <div class="left">
          <strong>${t.symbol}</strong>
          <span class="muted">${poolAddr ? short(poolAddr) : "No pool"}</span>
          ${poolAddr ? `<a class="extlink" href="${href}" target="_blank" rel="noopener" title="Open on explorer">↗</a>` : ""}
        </div>
        <div class="mid muted">Reserves: ${tvlTxt}</div>
        <div class="right muted">${poolAddr ? (fee + " bps") : ""}</div>
      `;
      $poolsList.appendChild(row);
    }
  }

  async function renderPositions(){
    if(!$positionsList || !signer) return;
    $positionsList.innerHTML="";
    const addr = await signer.getAddress();
    const items = tokensSorted().filter(t=>t.pool && t.pool!==ethers.ZeroAddress);
    for(const t of items){
      try{
        const p=poolAt(t.pool,true);
        const bal = await p.balanceOf(addr);
        if(bal>0n){
          const row=document.createElement("div");
          row.className="position";
          row.innerHTML=`
            <div class="left">
              <div class="title">${t.symbol}</div>
              <div class="muted">${short(t.pool)}</div>
            </div>
            <div class="right">
              <button class="btn btn-sm" data-act="remove" data-pool="${t.pool}" data-liq="${bal}">Remove</button>
            </div>
          `;
          $positionsList.appendChild(row);
        }
      }catch{}
    }
    $positionsList.querySelectorAll('button[data-act="remove"]').forEach(btn=>{
      btn.addEventListener("click", async()=>{
        if(!signer) return toast("Connect wallet first.","warn");
        const liq = BigInt(btn.getAttribute("data-liq")||"0");
        const poolAddr = btn.getAttribute("data-pool");
        await onRemove(liq, poolAddr);
      });
    });
  }

  /* --------------------------- Init --------------------------- */
 (async()=>{
  try{
    mobileNavFallback();                 // <-- thêm dòng này
    await refreshRegistry();
    renderAllPickers();
    attachLiquiditySync();
    await renderPoolsList();
    syncView();
  }catch(e){ console.warn(e); }
})();

})();
