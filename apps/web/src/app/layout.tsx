import type { Metadata } from "next";
import { Providers } from "@/components/layout/providers";
import { Header } from "@/components/layout/header";
import "./globals.css";

export const metadata: Metadata = {
  title: "HlOne — Hyperliquid Trading Terminal",
  description: "Smart money flow, whale alerts, and copy trading for Hyperliquid",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          // localStorage polyfill — must run before ANY other JS
          (function(){var n=false;try{if(typeof localStorage==='undefined'){n=true}else if(typeof localStorage.getItem!=='function'){n=true}else{localStorage.setItem('__t','1');localStorage.removeItem('__t')}}catch(e){n=true}if(n){var m={};var p={getItem:function(k){return m.hasOwnProperty(k)?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},get length(){return Object.keys(m).length},key:function(i){return Object.keys(m)[i]||null}};try{Object.defineProperty(window,'localStorage',{value:p,writable:true,configurable:true})}catch(e){try{window.localStorage=p}catch(e2){}}}})();
          // Theme: apply saved preference before paint to prevent flash
          (function(){try{var t=localStorage.getItem('hlone-theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light')}else{document.documentElement.setAttribute('data-theme','dark')}}catch(e){}})();
          // Suppress localStorage errors and non-critical wallet errors from crashing the page
          function isLSError(e){return e&&(String(e.message||e).includes('localStorage')||String(e.reason&&e.reason.message||'').includes('localStorage'))}
          function isWalletError(e){var m=String(e&&(e.message||e.reason&&e.reason.message)||'');return m.includes('connector')&&m.includes('not found')||m.includes('WalletConnect')||m.includes('wagmi')}
          function reportErr(msg,stack,comp){try{fetch('/api/market/client-error',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:String(msg).slice(0,500),stack:String(stack||'').slice(0,1000),component:comp,url:location.href})})}catch(x){}}
          window.addEventListener('error',function(e){if(isLSError(e)||isWalletError(e)){e.stopImmediatePropagation();e.preventDefault();return false}reportErr(e.message,e.error&&e.error.stack,'window.onerror')},true);
          window.addEventListener('unhandledrejection',function(e){if(isLSError(e)||isWalletError(e)){e.stopImmediatePropagation();e.preventDefault();return false}var r=e.reason;reportErr(r&&r.message||String(r),r&&r.stack,'unhandledrejection')},true);
          // Aggressively remove Next.js error overlay — it causes a red bar flash
          (function(){var o=new MutationObserver(function(m){m.forEach(function(r){r.addedNodes.forEach(function(n){if(n.tagName&&n.tagName.toLowerCase()==='nextjs-portal'){n.remove()}})})});o.observe(document.documentElement,{childList:true,subtree:true})})();
          setInterval(function(){document.querySelectorAll('nextjs-portal').forEach(function(el){el.remove()})},100);
        ` }} />
      </head>
      <body
        className="min-h-screen bg-[var(--background)] text-[var(--foreground)] antialiased"
      >
        <Providers>
          <Header />
          <main className="w-full px-4 sm:px-6 lg:px-8 py-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
