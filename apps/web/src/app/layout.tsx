import type { Metadata } from "next";
import { Providers } from "@/components/layout/providers";
import { Header } from "@/components/layout/header";
import "./globals.css";

export const metadata: Metadata = {
  title: "HlOne – Hyperliquid Homepage",
  description: "Perps, options and data.",
  openGraph: {
    title: "HlOne – Hyperliquid Homepage",
    description: "Perps, options and data.",
    siteName: "HlOne",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "HlOne – Hyperliquid Homepage",
    description: "Perps, options and data.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" data-theme="dark" suppressHydrationWarning
      style={{ colorScheme: 'dark' }}>
      <head>
        <meta name="theme-color" content="#060a0c" />
        <meta name="color-scheme" content="dark" />
        <style dangerouslySetInnerHTML={{ __html: `:root,[data-theme="dark"]{--background:#060a0c;--hl-nav:#040808}[data-theme="light"]{--background:#faf8f5;--hl-nav:#fdfcf9}html{background:var(--background)!important}body{background:transparent!important}nextjs-portal,nextjs-portal *,[data-nextjs-dialog-overlay],[data-nextjs-dialog-overlay] *,[data-nextjs-toast],[data-nextjs-toast] *,#__next-build-indicator,#__next-build-indicator *,[class*="nextjs-container-errors"],[class*="nextjs-container-errors"] *,[data-nextjs-scroll-focus-boundary]>[role="dialog"],body>iframe[style*="border"][style*="z-index"]{display:none!important;visibility:hidden!important;opacity:0!important;height:0!important;width:0!important;overflow:hidden!important;position:absolute!important;pointer-events:none!important;max-height:0!important}` }} />
        <script dangerouslySetInnerHTML={{ __html: `
          // localStorage polyfill — must run before ANY other JS
          (function(){var n=false;try{if(typeof localStorage==='undefined'){n=true}else if(typeof localStorage.getItem!=='function'){n=true}else{localStorage.setItem('__t','1');localStorage.removeItem('__t')}}catch(e){n=true}if(n){var m={};var p={getItem:function(k){return m.hasOwnProperty(k)?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},get length(){return Object.keys(m).length},key:function(i){return Object.keys(m)[i]||null}};try{Object.defineProperty(window,'localStorage',{value:p,writable:true,configurable:true})}catch(e){try{window.localStorage=p}catch(e2){}}}})();
          // Theme: apply saved preference before paint to prevent flash
          (function(){try{var t=localStorage.getItem('hlone-theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light')}else{document.documentElement.setAttribute('data-theme','dark')}}catch(e){}})();
          // Suppress localStorage errors and non-critical wallet/Reown errors from crashing the page
          // Also silence Reown's noisy console.warn about project config 403
          (function(){var ow=console.warn;console.warn=function(){var a=String(arguments[0]||'');if(a.includes('Reown')||a.includes('reown')||a.includes('Lit is in dev'))return;ow.apply(console,arguments)}})();
          function isLSError(e){return e&&(String(e.message||e).includes('localStorage')||String(e.reason&&e.reason.message||'').includes('localStorage'))}
          function isWalletError(e){var m=String(e&&(e.message||e.reason&&e.reason.message)||'');return m.includes('connector')&&m.includes('not found')||m.includes('WalletConnect')||m.includes('wagmi')||m.includes('Reown')||m.includes('reown')||m.includes('appkit')}
          function reportErr(msg,stack,comp){try{fetch('/api/market/client-error',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:String(msg).slice(0,500),stack:String(stack||'').slice(0,1000),component:comp,url:location.href})})}catch(x){}}
          window.addEventListener('error',function(e){if(isLSError(e)||isWalletError(e)){e.stopImmediatePropagation();e.preventDefault();return false}reportErr(e.message,e.error&&e.error.stack,'window.onerror')},true);
          window.addEventListener('unhandledrejection',function(e){if(isLSError(e)||isWalletError(e)){e.stopImmediatePropagation();e.preventDefault();return false}var r=e.reason;reportErr(r&&r.message||String(r),r&&r.stack,'unhandledrejection')},true);
          // Aggressively remove Next.js error overlay — it causes a red bar flash
          (function(){
            var sel='nextjs-portal,[data-nextjs-dialog-overlay],[data-nextjs-toast],[class*="nextjs-container-errors"],#__next-build-indicator';
            function nuke(){document.querySelectorAll(sel).forEach(function(el){el.remove()});
              // Also kill any body>iframe overlays Next.js injects
              document.querySelectorAll('body>iframe').forEach(function(f){if(f.style&&(f.style.zIndex>9000||f.style.position==='fixed'))f.remove()});
            }
            var o=new MutationObserver(function(m){m.forEach(function(r){r.addedNodes.forEach(function(n){if(!n.tagName)return;var t=n.tagName.toLowerCase();if(t==='nextjs-portal'||t==='iframe'||(n.dataset&&(n.dataset.nextjsDialogOverlay!==undefined||n.dataset.nextjsToast!==undefined))){n.remove()}})});nuke()});
            o.observe(document.documentElement,{childList:true,subtree:true});
            setInterval(nuke,80);
          })();
        ` }} />
      </head>
      <body
        className="min-h-screen text-[var(--foreground)] antialiased"
      >
        {/* Static loading screen — visible instantly before JS loads.
            Covers the entire viewport so nothing behind can flash (red bar fix).
            React app calls window.__hideStaticLoader() on mount to remove it. */}
        <div id="static-loader" style={{
          position: 'fixed', inset: 0, zIndex: 99999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#060a0c',
          willChange: 'transform',
        }}>
          <img src="/portalspin.gif" alt="" width={112} height={112} />
        </div>
        <script dangerouslySetInnerHTML={{ __html: `
          window.__hideStaticLoader=function(){var el=document.getElementById('static-loader');if(el)el.style.display='none'};
          // Match theme — the inline <style> block already sets --background per data-theme,
          // and all elements use var(--background), so just update the meta tag for browser chrome
          try{var t=localStorage.getItem('hlone-theme');if(t==='light'){var tc=document.querySelector('meta[name=theme-color]');if(tc)tc.setAttribute('content','#faf8f5')}}catch(e){}
          // Safety: hide after 12s even if React never mounts
          setTimeout(window.__hideStaticLoader,12000);
        ` }} />
        <Providers>
          <Header />
          <main className="w-full px-2 sm:px-6 lg:px-8 py-2 sm:py-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
