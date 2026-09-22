window.FinViz = (() => {
  const root = document.getElementById("visualization-root");
  const panel = document.getElementById("insight-panel");
  const shell = document.getElementById("app-shell");

  function escapeHtml(value="") {
    return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function money(v){
    const n = Number(v);
    return Number.isFinite(n) ? new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(n) : String(v ?? "—");
  }
  function open(){ shell.classList.add("insight-open"); panel.setAttribute("aria-hidden","false"); }
  function close(){ shell.classList.remove("insight-open"); panel.setAttribute("aria-hidden","true"); document.dispatchEvent(new CustomEvent("fin:visualization-close")); }

  function extractMetrics(text){
    const vals=[...String(text).matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)].slice(0,4).map(m=>`$${m[1]}`);
    const pct=[...String(text).matchAll(/\b(\d{1,3})%/g)].slice(0,2).map(m=>`${m[1]}%`);
    return [...vals,...pct].slice(0,4);
  }

  function fallback(type, title, answer){
    const metrics=extractMetrics(answer);
    root.innerHTML=`<section class="viz"><div class="viz-kicker">Fin’s chalkboard ✦</div><h2>${escapeHtml(title)}</h2><div class="viz-sub">A visual companion to the answer in chat</div>${metrics.length?`<div class="viz-grid">${metrics.map((m,i)=>`<div class="stat"><b>${escapeHtml(m)}</b><small>${["key amount","another useful number","percentage","detail"][i]||"detail"}</small></div>`).join("")}</div>`:""}<div class="fin-take"><div class="fin-take-title">Fin’s Take</div><div>${escapeHtml(answer||"I’ll put the useful details here whenever a visual breakdown helps.")}</div></div></section>`;
    open();
  }

  function spending(data={}){
    const cats = data.categories || data.purchases_by_category || {};
    const entries = Array.isArray(cats) ? cats.map(x=>[x.name,x.amount]) : Object.entries(cats);
    const total = Number(data.total ?? data.purchases_total ?? entries.reduce((s,[,v])=>s+Number(v||0),0));
    root.innerHTML=`<section class="viz"><div class="viz-kicker">Spending overview</div><h2>${escapeHtml(data.title||"Your spending")}</h2><div class="viz-sub">Here’s the breakdown</div><div class="hero-metric"><strong>${money(total)}</strong><span>spent</span></div>${entries.length?entries.map(([name,val])=>{const p=total>0?Math.max(2,Math.round(Number(val)/total*100)):0;return `<div class="bar-row"><div class="bar-label"><span>${escapeHtml(name)}</span><span>${money(val)} · ${p}%</span></div><div class="bar"><span style="width:${p}%"></span></div></div>`}).join(""):""}<div class="fin-take"><div class="fin-take-title">Fin’s Take</div><div>${escapeHtml(data.take||data.summary||"Your live Notion totals appear here when Fin sends structured visualization data.")}</div></div></section>`; open();
  }
  function bills(data={}){
    const items=data.items||data.bills||data.due_in_next_7_days||[];
    root.innerHTML=`<section class="viz"><div class="viz-kicker">Bills</div><h2>${escapeHtml(data.title||"Coming up")}</h2><div class="viz-sub">What deserves your attention next</div><div class="timeline">${items.length?items.map(b=>`<div class="timeline-item"><time>${escapeHtml(b.date||b.due||"")}</time><strong>${escapeHtml(b.name||b.title||"Bill")}</strong><span>${money(b.amount)}</span></div>`).join(""):`<div class="fin-take"><div class="fin-take-title">Fin’s Take</div>${escapeHtml(data.summary||"I’ll list upcoming bills here when the backend sends them.")}</div>`}</div></section>`;open();
  }
  function savings(data={}){
    const saved=Number(data.saved??data.current??0), target=Number(data.target??0), pct=target>0?Math.min(100,Math.round(saved/target*100)):0;
    root.innerHTML=`<section class="viz"><div class="viz-kicker">Savings goal</div><h2>${escapeHtml(data.goal||data.title||"Your goal")}</h2><div class="hero-metric"><strong>${money(saved)}</strong><span>saved${target?` of ${money(target)}`:""}</span></div><div class="bar-row"><div class="bar-label"><span>Progress</span><span>${pct}%</span></div><div class="bar"><span style="width:${pct}%"></span></div></div><div class="fin-take"><div class="fin-take-title">Fin’s Take</div>${escapeHtml(data.summary||data.take||"Small steps count. ♡")}</div></section>`;open();
  }
  function income(data={}){
    const entries=data.entries||data.income_entries||[];const total=Number(data.total??data.income_logged??entries.reduce((s,x)=>s+Number(x.amount||0),0));
    root.innerHTML=`<section class="viz"><div class="viz-kicker">Income</div><h2>${escapeHtml(data.title||"Money in")}</h2><div class="hero-metric"><strong>${money(total)}</strong><span>logged</span></div><div class="timeline">${entries.map(x=>`<div class="timeline-item"><time>${escapeHtml(x.date||"")}</time><strong>${escapeHtml(x.source||x.note||"Income")}</strong><span>${money(x.amount)}</span></div>`).join("")}</div><div class="fin-take"><div class="fin-take-title">Fin’s Take</div>${escapeHtml(data.summary||"Income saved successfully deserves a little magic.")}</div></section>`;open();
  }
  function render(viz, answer=""){
    if(!viz){return false} const type=String(viz.type||"").toLowerCase(); const data=viz.data||viz;
    if(type.includes("spend")||type.includes("budget")) spending(data); else if(type.includes("bill")) bills(data); else if(type.includes("sav")||type.includes("goal")) savings(data); else if(type.includes("income")) income(data); else fallback(type||"insight",viz.title||"Fin’s insight",answer||viz.summary||"");
    return true;
  }
  return {open,close,render,fallback,spending,bills,savings,income};
})();

document.getElementById("close-insight")?.addEventListener("click",()=>window.FinViz.close());