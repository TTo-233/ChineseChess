/* jieqi worker core — injected verbatim into jieqi.worker.bin
 * by client/scripts/gen-jieqi-host.mjs. Do not edit the generated file;
 * edit THIS file instead.
 *
 * Model: one-shot batch UCI session (see jieqiHost.ts for the rationale).
 *
 * Protocol:
 *   in : { type: 'session', commands: string[], wasmUrl: string }
 *   out: { type: 'start', banner, options }
 *        { type: 'line', line }
 *        { type: 'done', lines, banner, options }
 *        { type: 'error', message }
 *
 * ---------------------------------------------------------------------------
 * Why the wasm is a separate asset and why noInitialRun is NOT set
 * ---------------------------------------------------------------------------
 * Both facts were established empirically in headless Chrome:
 *
 * 1) wasm delivery
 *    The glue only reads these Module keys: locateFile, noFSInit, stdin,
 *    print, printErr, _main, noInitialRun. `wasmBinary` and `readBinary` are
 *    closure variables with no moduleArg assignment, so they cannot be
 *    injected. Inside a Worker the glue installs its own fallbacks:
 *      readBinary = url => synchronous XHR GET
 *      readAsync  = url => fetch(url, {credentials:'same-origin'})
 *    and a synchronous XHR cannot set `responseType` in a Worker, so that
 *    fallback is effectively dead.
 *    Measured:
 *      - Worker from a blob: URL  -> fetch(data:...) fails ("Failed to fetch"),
 *        because a blob worker has an opaque origin.
 *      - Worker from a same-origin URL, wasm as data: URL -> fetch succeeds but
 *        instantiateStreaming rejects it (CompileError: expected magic word
 *        00 61 73 6d, found "Asse") because the data: response is text.
 *    => the wasm must be a REAL same-origin http(s) asset served as
 *       application/wasm, which is exactly the path the glue expects
 *       (fetch + instantiateStreaming). The host passes that URL in.
 *
 * 2) noInitialRun
 *    The glue's run() calls callMain(), which drives UCI::loop() and consumes
 *    the whole stdin sequence (~147 stdin callbacks for a 6-command session).
 *    If noInitialRun is set, run() skips callMain; calling mod._main()
 *    manually then fails silently because initRuntime()/TTY.init() has already
 *    taken over stdin, so UCI::loop() sees EOF and exits before any command.
 *    => leave noInitialRun unset and let the glue do it.
 */
self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.type !== 'session') return;

  var commands = msg.commands || [];
  var wasmUrl = msg.wasmUrl;
  if (!wasmUrl) {
    self.postMessage({ type: 'error', message: 'session missing wasmUrl' });
    return;
  }

  var stdinText = commands.join('\n') + '\n';
  var stdinPos = 0;
  var lines = [];
  var banner = '';
  var options = [];

  function stdinFn() {
    if (stdinPos >= stdinText.length) return null; /* EOF -> UCI loop exits */
    return stdinText.charCodeAt(stdinPos++);
  }

  function emit(line) {
    var l = String(line).trim();
    if (!l) return;
    if (l.indexOf('id name ') === 0) { banner = l.slice(8).trim(); return; }
    if (l.indexOf('option name ') === 0) {
      var m = /^option name (\S+)/.exec(l);
      if (m) options.push(m[1]);
      return;
    }
    lines.push(l);
  }

  function printFn(t) {
    var parts = String(t).split('\n');
    for (var i = 0; i < parts.length; i++) emit(parts[i]);
  }

  self.postMessage({ type: 'start', banner: banner, options: options });

  try {
    /* glue declares the factory as `var PikaJieqi = (()=>{...})()` in the same
       IIFE scope, so the bare identifier resolves here. */
    var factory = (typeof PikaJieqi !== 'undefined') ? PikaJieqi : self.PikaJieqi;
    if (typeof factory !== 'function') {
      self.postMessage({ type: 'error', message: 'PikaJieqi factory not found' });
      return;
    }
    factory({
      print: printFn,
      printErr: printFn,
      locateFile: function (f) {
        if (/\.wasm(\?|#|$)/i.test(String(f || ''))) return wasmUrl;
        return f;
      },
      stdin: stdinFn,
    }).then(function () {
      /* By now the glue has run callMain() and the whole command sequence has
         been processed, so all engine output has been collected. */
      self.postMessage({ type: 'done', lines: lines, banner: banner, options: options });
    }).catch(function (e) {
      self.postMessage({ type: 'error', message: 'engine init failed: ' + (e && e.message || e) });
    });
  } catch (e) {
    self.postMessage({ type: 'error', message: 'engine threw: ' + (e && e.message || e) });
  }
};
