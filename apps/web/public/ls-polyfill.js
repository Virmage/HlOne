// localStorage polyfill for sandboxed browsers where localStorage
// exists but its methods aren't real functions.
(function() {
  var needsPatch = false;
  try {
    if (typeof localStorage === 'undefined') {
      needsPatch = true;
    } else if (typeof localStorage.getItem !== 'function') {
      needsPatch = true;
    } else {
      // Methods exist — test if they actually work
      localStorage.setItem('__ls_test__', '1');
      localStorage.removeItem('__ls_test__');
    }
  } catch(e) {
    needsPatch = true;
  }

  if (needsPatch) {
    var mem = {};
    var proxy = {
      getItem: function(k) { return mem.hasOwnProperty(k) ? mem[k] : null; },
      setItem: function(k, v) { mem[k] = String(v); },
      removeItem: function(k) { delete mem[k]; },
      clear: function() { mem = {}; },
      get length() { return Object.keys(mem).length; },
      key: function(i) { return Object.keys(mem)[i] || null; }
    };
    try {
      Object.defineProperty(window, 'localStorage', {
        value: proxy,
        writable: true,
        configurable: true
      });
    } catch(e) {
      // If defineProperty fails, try direct assignment
      try { window.localStorage = proxy; } catch(e2) {}
    }
  }
})();
