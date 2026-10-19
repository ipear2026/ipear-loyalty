// ═══════════════════════════════════════════════════════════════════════════
//  iPear Loyalty — Tablet Login Boot Guard
//
//  Phase 19: the login-button boot guard that used to live inline at the end
//  of <body> in tablet.html. Extracting it lets the CSP drop
//  `script-src 'unsafe-inline'` for the tablet entry. Loaded as a classic
//  (non-module) script at the end of <body> — same position as the former
//  inline block — so #tl-btn / #tl-err exist and it runs before the deferred
//  tablet-main.js module. Byte-for-byte the former inline IIFE.
// ═══════════════════════════════════════════════════════════════════════════
(function(){
  var btn=document.getElementById('tl-btn');
  if(btn){btn.disabled=true;btn.textContent='⏳ Φόρτωση...';}
  window.addEventListener('vite:preloadError',function(e){e.preventDefault();location.reload();});
  window.addEventListener('tablet-ready',function(){
    if(btn){btn.disabled=false;btn.textContent='Είσοδος →';}
  });
  setTimeout(function(){
    if(typeof window.tabletLogin!=='function'){
      var err=document.getElementById('tl-err');
      if(err)err.textContent='⚠️ Αργή σύνδεση — επαναφόρτωση...';
      setTimeout(function(){location.reload();},2000);
    }
  },15000);
})();
