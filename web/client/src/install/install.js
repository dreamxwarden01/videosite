// videosite — first-run installer.
//
// Standalone page (no React). Renders into #install-root and drives the real
// install API in routes/install.js. Five steps:
//
//   1 Infrastructure  POST /api/install/infra    probes DB/Redis/R2, applies the
//                                                schema, runs migrations, writes .env
//   2 Site            POST /api/install/site     name + hostname; everything derives
//   3 SSO             POST /api/install/sso      saves the connection, MINTS our key
//   4 Certificate     /api/install/mtls[/csr|/cert]   optional client certificate
//   5 Connect         GET  /api/install/connect  paste sheet + JWKS pre-flight
//                     POST /api/install/verify   the gate: one signed roles.sync
//                     POST /api/install/finish   re-verifies, then locks the installer
//
// The install_token cookie authorises every call, so plain same-origin fetch is
// all that's needed.
//
// THE GATE: step 5 has no Skip and no Continue. Its primary is "Verify & connect"
// and only becomes "Go to sign-in" after the SSO answers 204. finish() re-verifies
// server-side anyway, so a stale client-side "verified" cannot get through.
//
// No account is created anywhere in here. videosite has no passwords of its own —
// whoever holds the root role at the SSO becomes this site's administrator the
// moment the role catalogue is published (which is what verify does).
(function () {
    'use strict';

    // The SPA shell locks scrolling; the installer is a long form.
    document.documentElement.style.overflow = 'auto';
    document.documentElement.style.height = 'auto';
    document.body.style.overflow = 'auto';
    document.body.style.height = 'auto';

    var root = document.getElementById('install-root');
    if (!root) return;

    // ========================================================================
    // STYLES
    //
    // Built on videosite's real .vs-* tokens (flat cards, 500-weight headings,
    // #c5221f errors, #1a73e8 accent) but installer-only: the stepper, the card
    // shell, the rung ladder and the paste sheet have no counterpart in the SPA.
    // Everything is scoped under #install-root so these generic class names
    // (.card, .btn, .note…) can never collide with style.css.
    // ========================================================================
    var CSS = `
#install-root{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;font-size:14px;line-height:1.5;color:#333;background:#f0f2f5;min-height:100vh;display:flex;justify-content:center;padding:32px 24px 70px}
#install-root *{box-sizing:border-box}
#install-root .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
#install-root .wrap{width:100%;max-width:560px}
#install-root .eyebrow{display:flex;align-items:center;justify-content:center;gap:7px;margin:0 0 14px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#9ca3af}
#install-root .eyebrow svg{width:13px;height:13px}
#install-root .card{background:#fff;border:1px solid #eef0f2;border-radius:12px;padding:24px 26px 22px}

/* brand — .vs-brand-mark: solid #1a73e8, 27px, 7px radius. No gradient, no glow. */
#install-root .brand{display:flex;align-items:center;gap:8px;margin-bottom:20px}
#install-root .badge{width:27px;height:27px;border-radius:7px;background:#1a73e8;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0}
#install-root .badge svg{width:15px;height:15px}
#install-root .wordmark{font-size:14px;font-weight:500;color:#1f2937;letter-spacing:-.01em}
#install-root .wordmark small{display:block;font-size:11.5px;font-weight:400;color:#9ca3af;letter-spacing:0}

/* stepper — no videosite component to borrow; built from its own tokens. */
#install-root .steps{display:flex;list-style:none;margin:0 0 22px;padding:0}
#install-root .step{flex:1;display:flex;flex-direction:column;align-items:center;position:relative;font-size:10.5px;color:#9ca3af;text-align:center}
#install-root .step::before{content:'';position:absolute;top:11px;right:50%;width:100%;height:2px;background:#e5e7eb;z-index:0}
#install-root .step:first-child::before{display:none}
#install-root .step.done::before,#install-root .step.active::before{background:#1a73e8}
#install-root .dot{width:24px;height:24px;border-radius:50%;background:#fff;border:1.5px solid #e5e7eb;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500;color:#9ca3af;z-index:1;margin-bottom:6px;transition:.2s}
#install-root .dot svg{width:12px;height:12px}
#install-root .step.active .dot{border-color:#1a73e8;color:#1a73e8}
#install-root .step.done .dot{background:#1a73e8;border-color:#1a73e8;color:#fff}
#install-root .step.active .lbl{color:#1f2937;font-weight:500}
#install-root .step.blocked .dot{border-color:#c5221f;color:#c5221f}
#install-root .step.blocked .lbl{color:#c5221f}

/* type — .vs-set-title / .vs-set-sub / .vs-perm-grp on a .vs-pane-sec divider. */
#install-root h1{font-size:20px;font-weight:500;color:#1f2937;margin:0 0 4px}
#install-root .sub{font-size:12.5px;color:#6b7280;margin:0 0 18px;line-height:1.5;max-width:640px}
#install-root h2.grp{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#9ca3af;margin:22px 0 10px;padding-top:18px;border-top:1px solid #eef0f2}
#install-root h2.grp:first-of-type{margin-top:0;padding-top:0;border-top:0}

/* fields — .vs-field / .vs-label / .vs-input. Inputs inherit the SYSTEM stack:
   a placeholder must never look like a value the user typed, so nothing is mono. */
#install-root .grp-f{margin-bottom:14px}
#install-root .grp-f:last-child{margin-bottom:0}
#install-root .row{display:flex;gap:12px}
#install-root .row>.grp-f{flex:1;min-width:0}
#install-root .row>.grp-f.narrow{flex:0 0 116px}
#install-root .fl{display:block;font-size:12px;font-weight:500;color:#374151;margin-bottom:5px}
#install-root .fl .opt{float:right;font-weight:400;color:#9ca3af;font-size:11px}
#install-root .card input,#install-root .card select,#install-root .card textarea{width:100%;border:1px solid #d1d5db;border-radius:8px;padding:8px 11px;font-size:13.5px;font-family:inherit;color:#1f2937;background:#fff;transition:border-color .12s,box-shadow .12s}
#install-root .card input:focus,#install-root .card select:focus,#install-root .card textarea:focus{outline:none;border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,.12)}
#install-root .card input:read-only,#install-root .card input:disabled,#install-root .card select:disabled{background:#f8f9fa;color:#6b7280;cursor:default}
#install-root .card input::placeholder,#install-root .card textarea::placeholder{color:#9ca3af}
#install-root .card select{appearance:none;padding-right:30px;background-repeat:no-repeat;background-position:right 9px center;background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%236b7280' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E")}
/* textareas hold PEM blocks — genuinely mono content (.vs-mono-area). */
#install-root .card textarea{font-family:monospace;font-size:12px;background:#f9fafb;min-height:104px;white-space:pre;overflow-x:auto;resize:vertical;line-height:1.5}
#install-root .card input.mono,#install-root .card .cv{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
#install-root .hint{font-size:11.5px;color:#6b7280;margin:5px 0 0;line-height:1.45}
#install-root .hint b{color:#374151;font-weight:500}
#install-root .hint code{font-family:ui-monospace,Menlo,monospace;font-size:11px;background:#f1f3f4;padding:1px 4px;border-radius:4px;color:#5f6368}
#install-root .hint-c{text-align:center;margin-top:12px}
#install-root .field-err{display:none;font-size:12px;color:#c5221f;margin-top:5px;line-height:1.45}
#install-root .grp-f.bad .field-err{display:block}
#install-root .grp-f.bad input,#install-root .grp-f.bad textarea{border-color:#c5221f}
#install-root .grp-f.bad input:focus,#install-root .grp-f.bad textarea:focus{box-shadow:0 0 0 3px rgba(197,34,31,.12)}
#install-root .compound{display:flex}
#install-root .compound select{width:104px;flex-shrink:0;border-radius:8px 0 0 8px;border-right:0}
#install-root .compound input{border-radius:0 8px 8px 0}
#install-root .lrow{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:5px}
#install-root .lrow .fl{margin:0}
#install-root .lrow .fl .opt{float:none;margin-left:6px}
#install-root .reveal{background:none;border:0;font-family:inherit;font-size:11.5px;font-weight:500;color:#1a73e8;cursor:pointer;padding:0}

/* segmented — .vs-seg / .vs-seg-btn (flat: no shadow on .on). */
#install-root .seg{display:inline-flex;background:#eceef1;border-radius:9px;padding:3px;gap:2px}
#install-root .seg button{border:1px solid transparent;background:none;font-family:inherit;font-size:13px;color:#6b7280;padding:6px 13px;border-radius:7px;cursor:pointer}
#install-root .seg button.on{background:#fff;color:#1f2937;font-weight:500;border-color:#e0e2e6}
#install-root .seg button:disabled{color:#c3c8cf;cursor:default}

/* notes — neutral #f8f9fa; warn = .vs-warn; info from the accent pill pair. */
#install-root .note{border:1px solid #eef0f2;background:#f8f9fa;border-radius:8px;padding:10px 12px;font-size:12.5px;color:#6b7280;line-height:1.5;margin:14px 0 0}
#install-root .note b{color:#374151;font-weight:500}
#install-root .note code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:#f1f3f4;padding:1px 4px;border-radius:4px;color:#5f6368}
#install-root .note.warn{background:#fef7e0;border-color:#fde293;color:#7c4a00}
#install-root .note.warn b,#install-root .note.warn code{color:#7c4a00}
#install-root .note.warn code{background:#fdf0cd}
#install-root .note.info{background:#e8f0fe;border-color:#e8f0fe;color:#5f6368}
/* emphasis inside the info note stays NEUTRAL — bold accent-blue reads as a link. */
#install-root .note.info b{color:#1f2937;font-weight:500}
#install-root .note.info code{background:#fff;color:#1a73e8}
#install-root .banner{display:none;background:#fce8e6;border:1px solid #f2b8b5;color:#c5221f;border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.5;margin-bottom:16px}
#install-root .banner.on{display:block}

/* probe line */
#install-root .probe{font-size:12px;margin:8px 0 0;display:flex;align-items:flex-start;gap:7px;color:#6b7280}
#install-root .probe .pd{width:8px;height:8px;border-radius:50%;margin-top:4px;background:#9ca3af;flex-shrink:0}
#install-root .probe.ok{color:#137333}
#install-root .probe.ok .pd{background:#137333}
#install-root .probe.warn{color:#7c4a00}
#install-root .probe.warn .pd{background:#b06000}
#install-root .probe.err{color:#c5221f}
#install-root .probe.err .pd{background:#c5221f}
#install-root .probe.checking .pd{animation:vsi-pp 1s ease-in-out infinite}
#install-root .probe.pending{color:#6b7280}
#install-root .probe.pending .pd{background:#1a73e8;animation:vsi-pp 1.4s ease-in-out infinite}
@keyframes vsi-pp{0%,100%{opacity:.25;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}
#install-root .linkbtn{background:none;border:0;padding:0;font-family:inherit;font-size:12px;font-weight:500;color:#1a73e8;cursor:pointer}
#install-root .linkbtn:hover{text-decoration:underline}

/* checklists — the #d1fae5/#065f46 green pairing (.sso-pill.green, .perm-grant). */
#install-root .token-chip{display:inline-flex;align-items:center;gap:6px;background:#d1fae5;color:#065f46;border-radius:20px;padding:3px 11px 3px 8px;font-size:12px;font-weight:500;margin-bottom:8px}
#install-root .token-chip svg{width:13px;height:13px}
#install-root .checks{margin-top:6px}
#install-root .chk{display:flex;gap:11px;padding:11px 2px;border-bottom:1px solid #f1f3f4}
#install-root .chk:last-child{border-bottom:0}
#install-root .chk-ico{width:22px;height:22px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;margin-top:1px}
#install-root .chk-ico svg{width:13px;height:13px}
#install-root .chk-ico.ok{background:#d1fae5}
#install-root .chk-ico.info{background:#e8f0fe}
#install-root .chk-ico.wait{background:#f1f3f4}
#install-root .chk-body{min-width:0;flex:1}
#install-root .chk-name{font-size:14px;font-weight:500;color:#1f2937}
#install-root .chk-val{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#6b7280;word-break:break-all;margin-top:2px}
#install-root .chk-note{font-size:11.5px;color:#9ca3af;margin-top:3px;line-height:1.5}
#install-root .chk-note code{font-family:ui-monospace,Menlo,monospace;background:#f1f3f4;padding:1px 4px;border-radius:4px}

/* live ticker (step 1) */
#install-root .tick{margin:2px 0 0;padding:0;list-style:none}
#install-root .tick li{display:flex;gap:9px;align-items:flex-start;padding:8px 0;font-size:12.5px;color:#9ca3af;border-bottom:1px solid #f1f3f4}
#install-root .tick li:last-child{border-bottom:0}
#install-root .tick .ti{width:16px;height:16px;flex-shrink:0;margin-top:1px;border-radius:50%;border:2px solid #e5e7eb}
#install-root .tick li.run{color:#374151}
#install-root .tick li.run .ti{border-color:#1a73e8;border-right-color:transparent;animation:vsi-spin .7s linear infinite}
#install-root .tick li.ok{color:#137333}
#install-root .tick li.ok .ti,#install-root .tick li.bad .ti{border:0;display:flex;align-items:center;justify-content:center}
#install-root .tick li.ok .ti{background:#d1fae5}
#install-root .tick li.bad{color:#c5221f}
#install-root .tick li.bad .ti{background:#fce8e6}
#install-root .tick .ti svg{width:11px;height:11px}
#install-root .tick .sub2{display:block;font-size:11px;color:#9ca3af;font-family:ui-monospace,Menlo,monospace;word-break:break-all;margin-top:2px}
@keyframes vsi-spin{to{transform:rotate(360deg)}}

/* derived table + paste sheet — flat card, #eef0f2 hairlines. */
#install-root .derived{border:1px solid #eef0f2;border-radius:12px;overflow:hidden;margin-top:4px;background:#f8f9fa}
#install-root .derived-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;background:#f1f3f4;border-bottom:1px solid #eef0f2}
#install-root .derived-hd .t{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#9ca3af}
#install-root .drow{display:flex;align-items:center;gap:10px;padding:9px 12px;border-top:1px solid #eef0f2}
#install-root .drow:first-child{border-top:0}
#install-root .drow .k{flex:0 0 116px;font-size:12px;color:#6b7280}
#install-root .drow .v{flex:1;min-width:0;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:#1f2937;word-break:break-all}
#install-root .drow .v.muted{color:#6b7280;font-family:inherit;font-size:12px;line-height:1.45}
#install-root .crow{display:flex;align-items:center;gap:10px;padding:9px 12px;border-top:1px solid #eef0f2;background:#fff}
#install-root .crow:first-child{border-top:0}
#install-root .crow .ck{flex:0 0 116px;font-size:12px;color:#6b7280}
/* the paste-sheet readouts are selectable text, not fields — they must not wear
   the input box. :read-only above is (0,2,1), so name element+class+state. */
#install-root .card .cv,#install-root .card input.cv:read-only{flex:1;min-width:0;width:auto;border:0;background:none;padding:0;font-size:12.5px;color:#1f2937;text-overflow:ellipsis}
#install-root .card .cv:focus{outline:none;border-color:transparent;box-shadow:none}
/* pills — .vs-tc-pill and its four tones. */
#install-root .pill{display:inline-flex;align-items:center;font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;white-space:nowrap}
#install-root .pill.d{background:#e8f0fe;color:#1a73e8}
#install-root .pill.g{background:#e6f4ea;color:#188038}
#install-root .pill.y{background:#fef7e0;color:#b06000}
#install-root .pill.n{background:#f1f3f4;color:#6b7280}
#install-root .pill.r{background:#fce8e6;color:#c5221f}

/* buttons — .vs-btn tokens. */
#install-root .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #1a73e8;border-radius:8px;padding:7px 14px;font-family:inherit;font-size:13px;font-weight:500;line-height:1.35;cursor:pointer;background:#1a73e8;color:#fff;transition:background .12s,border-color .12s;white-space:nowrap;text-decoration:none}
#install-root .btn:hover:not(:disabled){background:#1557b0;border-color:#1557b0}
#install-root .btn:disabled{opacity:.5;cursor:default}
#install-root .btn svg{width:15px;height:15px;flex-shrink:0}
#install-root .btn-ghost{background:#fff;border-color:#d1d5db;color:#1f2937}
#install-root .btn-ghost:hover:not(:disabled){background:#f8f9fa;border-color:#9ca3af}
#install-root .btn-link{background:none;border-color:transparent;color:#5f6368;padding:7px 10px}
#install-root .btn-link:hover:not(:disabled){background:#eef0f3;border-color:transparent;color:#1f2937}
#install-root .btn-wide{width:100%}
#install-root .btn-sm{padding:5px 10px;font-size:12px}
#install-root .ico-btn{width:30px;height:30px;padding:0;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#5f6368;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}
#install-root .ico-btn:hover{background:#f8f9fa;border-color:#9ca3af;color:#1f2937}
#install-root .ico-btn svg{width:14px;height:14px}
#install-root .ico-btn.copied{background:#e6f4ea;border-color:#ceead6;color:#137333}
#install-root .nav{display:flex;gap:10px;margin-top:22px}
#install-root .nav .btn{flex:1}
/* LOAD-BEARING: an author display on .btn outranks the UA's [hidden] rule, so a
   hidden="" button keeps rendering — which is how "Skip for now" survives onto
   step 5 and punches a hole straight through the connect gate. */
#install-root [hidden]{display:none !important}
#install-root .nav .btn-ghost,#install-root .nav .btn-link{flex:0 0 auto}
#install-root .navnote{font-size:11.5px;color:#6b7280;line-height:1.5;margin:18px 0 0;text-align:center}
#install-root .navnote b{color:#374151;font-weight:500}
#install-root .copyrow{display:flex;gap:8px;align-items:center}
#install-root .copyrow input{flex:1;min-width:0}

/* the 3-rung verify ladder. CHILD combinators throughout: the diagnosis renders
   INSIDE the failing rung (.dslot), so descendant selectors would monospace its
   prose and paint its self-test labels red. */
#install-root .ladder{list-style:none;margin:6px 0 0;padding:0}
#install-root .rung{display:grid;grid-template-columns:18px 1fr;gap:2px 10px;padding:11px 2px;border-top:1px solid #f1f3f4}
#install-root .rung:first-child{border-top:0}
#install-root .rung>i{grid-row:1/3;width:18px;height:18px;border-radius:50%;background:#f1f3f4;margin-top:1px;display:flex;align-items:center;justify-content:center}
#install-root .rung>i svg{width:11px;height:11px}
#install-root .rung>b{font-size:14px;font-weight:500;color:#1f2937}
#install-root .rung>span{font-size:12px;color:#6b7280;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
#install-root .rung.idle>b,#install-root .rung.idle>span{color:#9ca3af}
#install-root .rung.run>i{background:#e8f0fe;animation:vsi-pulse 1.1s ease-in-out infinite}
#install-root .rung.ok>i{background:#e6f4ea}
#install-root .rung.fail>i{background:#fce8e6}
#install-root .rung.fail>b{color:#c5221f}
#install-root .rung .dslot{grid-column:2}
@keyframes vsi-pulse{0%,100%{opacity:1}50%{opacity:.45}}

/* diagnosis block — lives UNDER the failing rung, never in a banner. Body copy
   stays neutral #5f6368 so a paragraph of prose isn't shouted in red. */
#install-root .diag{margin:10px 0 2px;padding:12px 13px;border:1px solid #f2b8b5;border-radius:8px;background:#fce8e6}
#install-root .diag.amber{border-color:#fde293;background:#fef7e0}
#install-root .diag-h{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:6px 10px;font-size:13.5px;font-weight:500;color:#c5221f;margin-bottom:5px;line-height:1.45}
#install-root .diag-h>span:first-child{flex:1 1 auto;min-width:0;overflow-wrap:break-word}
#install-root .diag.amber .diag-h{color:#7c4a00}
#install-root .diag-h .codes{display:flex;gap:5px;flex:0 0 auto}
#install-root .diag-h code{font-size:10.5px;padding:2px 8px;border-radius:20px;background:#fff;color:#c5221f;font-family:ui-monospace,Menlo,monospace;font-weight:500}
#install-root .diag.amber .diag-h code{color:#7c4a00}
#install-root .diag p{margin:0;font-size:12.5px;line-height:1.5;color:#5f6368}
#install-root .diag.amber p{color:#7c4a00}
#install-root .diag p b{color:#1f2937;font-weight:500}
#install-root .diag.amber p b{color:#7c4a00}
#install-root .diag p code,#install-root .diag li code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:#fff;padding:1px 5px;border-radius:4px;color:#5f6368}
#install-root .fix{counter-reset:f;list-style:none;margin:11px 0 0;padding:0}
#install-root .fix li{counter-increment:f;position:relative;padding:0 0 9px 26px;font-size:12.5px;color:#5f6368;line-height:1.55}
#install-root .fix li b{color:#1f2937;font-weight:500}
#install-root .diag.amber .fix li,#install-root .diag.amber .fix li b{color:#7c4a00}
#install-root .fix li:last-child{padding-bottom:0}
#install-root .fix li::before{content:counter(f);position:absolute;left:0;top:1px;width:18px;height:18px;border-radius:50%;background:#fff;color:#c5221f;font-size:10.5px;font-weight:500;display:flex;align-items:center;justify-content:center}
#install-root .diag.amber .fix li::before{color:#7c4a00}
#install-root .fix .inl{display:flex;align-items:center;gap:6px;margin-top:6px}
#install-root .fix .inl input{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;padding:6px 9px;border-radius:8px;background:#fff}
#install-root .diag-a{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:12px}
#install-root .diag details{margin-top:10px}
#install-root .diag summary{cursor:pointer;font-size:12px;color:#5f6368;list-style:none}
#install-root .diag.amber summary{color:#7c4a00}
#install-root .diag summary::-webkit-details-marker{display:none}
#install-root .diag summary::before{content:'\\25B8  '}
#install-root .diag details[open] summary::before{content:'\\25BE  '}
#install-root .diag pre{margin:8px 0 0;padding:10px 12px;background:#f9fafb;border:1px solid #eef0f2;border-radius:8px;font-family:monospace;font-size:11.5px;color:#5f6368;overflow-x:auto;line-height:1.55;white-space:pre}
#install-root .subchk{margin:11px 0 0;padding:0;list-style:none;border:1px solid #eef0f2;border-radius:8px;overflow:hidden;background:#fff}
#install-root .subchk li{display:flex;align-items:flex-start;gap:9px;padding:9px 12px;font-size:12.5px;border-top:1px solid #f1f3f4;color:#6b7280}
#install-root .subchk li:first-child{border-top:0}
#install-root .subchk .m{width:15px;height:15px;flex-shrink:0;margin-top:2px;border-radius:50%;display:flex;align-items:center;justify-content:center}
#install-root .subchk .m.ok{background:#d1fae5}
#install-root .subchk .m.no{background:#fce8e6}
#install-root .subchk .m svg{width:10px;height:10px}
#install-root .subchk b{color:#1f2937;font-weight:500;display:block}
#install-root .subchk .why{display:block;font-size:11.5px;color:#6b7280;margin-top:2px;line-height:1.5}
#install-root .subchk li.no .why{color:#c5221f}

/* absolute-URL disclosure under the paste sheet */
#install-root .absurl{margin-top:12px}
#install-root .absurl summary{cursor:pointer;font-size:12px;font-weight:500;color:#1a73e8;list-style:none;padding:2px}
#install-root .absurl summary::-webkit-details-marker{display:none}
#install-root .absurl summary::before{content:'\\25B8  '}
#install-root .absurl[open] summary::before{content:'\\25BE  '}
#install-root .absurl summary:hover{text-decoration:underline}

/* handoff — accent surface, same family as the info note. */
#install-root .handoff{border:1px solid #e8f0fe;background:#e8f0fe;border-radius:12px;padding:14px 15px;margin-bottom:16px}
#install-root .handoff .t{font-size:14px;font-weight:500;color:#1a73e8;margin-bottom:3px}
#install-root .handoff .d{font-size:12.5px;color:#5f6368;line-height:1.5;margin-bottom:12px}
#install-root .handoff .acts{display:flex;gap:8px;flex-wrap:wrap}

/* success */
#install-root .done-badge{width:56px;height:56px;border-radius:50%;background:#e6f4ea;display:flex;align-items:center;justify-content:center;margin:4px auto 16px}
#install-root .done-badge svg{width:28px;height:28px}
#install-root .center{text-align:center}
#install-root .msg{font-size:12.5px;color:#6b7280;line-height:1.5;margin:0 auto 18px;max-width:420px}
#install-root .foot{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:16px;font-size:11px;color:#9ca3af}
#install-root .foot svg{width:11px;height:11px}
#install-root .hidden{display:none !important}
#install-root .panel{display:none}
#install-root .panel.on{display:block}
@media (max-width:560px){
  #install-root{padding:20px 12px 60px}
  #install-root .card{padding:20px 18px}
  #install-root .row{flex-wrap:wrap}
  #install-root .row>.grp-f.narrow{flex:0 0 116px}
}
@media (prefers-reduced-motion:reduce){#install-root *{animation:none !important;transition:none !important}}
`;

    var styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    // ========================================================================
    // MARKUP
    // ========================================================================
    root.innerHTML = `
<div class="wrap">

  <p class="eyebrow">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    First-run setup
  </p>

  <div class="card">
    <div class="brand">
      <span class="badge"><svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span>
      <span class="wordmark" id="wordmark">VideoSite<small>Nothing is written until you say so.</small></span>
    </div>

    <ol class="steps" id="stepper">
      <li class="step" data-i="0"><span class="dot">1</span><span class="lbl">Infrastructure</span></li>
      <li class="step" data-i="1"><span class="dot">2</span><span class="lbl">Site</span></li>
      <li class="step" data-i="2"><span class="dot">3</span><span class="lbl">SSO</span></li>
      <li class="step" data-i="3"><span class="dot">4</span><span class="lbl">Certificate</span></li>
      <li class="step" data-i="4"><span class="dot">5</span><span class="lbl">Connect</span></li>
    </ol>

    <div class="banner" id="banner"></div>

    <!-- ==================== STEP 1 — INFRASTRUCTURE ==================== -->
    <section class="panel" data-panel="0">
      <h1>Connect the infrastructure</h1>
      <p class="sub">videosite stores its data in MySQL, its sessions in Redis, and its video in Cloudflare R2. Nothing is written until all three answer.</p>

      <div id="s1-form">
        <div class="note" id="env-note">No <code>.env</code> found — the wizard will create one.</div>

        <h2 class="grp" style="margin-top:20px">Database</h2>
        <div class="grp-f">
          <label class="fl">Engine</label>
          <div class="seg">
            <button type="button" class="on">MySQL / MariaDB</button>
            <button type="button" disabled>PostgreSQL</button>
          </div>
          <p class="hint">PostgreSQL isn't supported yet — the schema and migrations are MySQL dialect.</p>
        </div>
        <div class="row">
          <div class="grp-f">
            <label class="fl" for="dbHost">Host</label>
            <input id="dbHost" data-req data-rule="nethost" placeholder="localhost">
            <span class="field-err"></span>
          </div>
          <div class="grp-f narrow">
            <label class="fl" for="dbPort">Port <span class="opt">3306</span></label>
            <input id="dbPort" data-rule="port" placeholder="3306">
            <span class="field-err"></span>
          </div>
        </div>
        <div class="row">
          <div class="grp-f">
            <label class="fl" for="dbUser">Username</label>
            <input id="dbUser" data-req data-rule="nospace">
            <span class="field-err"></span>
          </div>
          <div class="grp-f">
            <div class="lrow"><label class="fl" for="dbPassword">Password</label><button type="button" class="reveal" data-reveal="dbPassword">Show</button></div>
            <input id="dbPassword" type="password" data-req data-rule="text">
            <span class="field-err"></span>
          </div>
        </div>
        <div class="grp-f">
          <label class="fl" for="dbName">Database name</label>
          <input id="dbName" data-req data-rule="nospace" placeholder="videosite">
          <p class="hint">Created if it doesn't exist. Schema, seed data and migrations are applied on save.</p>
          <span class="field-err"></span>
        </div>
        <p class="probe hidden" id="s1-dbprobe"></p>

        <h2 class="grp">Redis</h2>
        <div class="row">
          <div class="grp-f">
            <label class="fl" for="redisHost">Host</label>
            <input id="redisHost" data-req data-rule="nethost" placeholder="localhost">
            <span class="field-err"></span>
          </div>
          <div class="grp-f narrow">
            <label class="fl" for="redisPort">Port <span class="opt">6379</span></label>
            <input id="redisPort" data-rule="port" placeholder="6379">
            <span class="field-err"></span>
          </div>
        </div>
        <div class="row">
          <div class="grp-f">
            <div class="lrow"><label class="fl" for="redisPassword">Password <span class="opt">optional</span></label><button type="button" class="reveal" data-reveal="redisPassword">Show</button></div>
            <input id="redisPassword" type="password" data-rule="text">
            <span class="field-err"></span>
          </div>
          <div class="grp-f narrow">
            <label class="fl" for="redisDb">DB index</label>
            <input id="redisDb" data-rule="port" placeholder="0">
            <span class="field-err"></span>
          </div>
        </div>

        <h2 class="grp">Object storage (Cloudflare R2)</h2>
        <div class="grp-f">
          <label class="fl" for="r2Endpoint">Endpoint</label>
          <input id="r2Endpoint" data-req data-rule="url" placeholder="https://ACCOUNT_ID.r2.cloudflarestorage.com">
          <span class="field-err"></span>
        </div>
        <div class="row">
          <div class="grp-f">
            <label class="fl" for="r2BucketName">Bucket</label>
            <input id="r2BucketName" data-req data-rule="nospace">
            <span class="field-err"></span>
          </div>
          <div class="grp-f">
            <label class="fl" for="r2PublicDomain">Public media domain</label>
            <input id="r2PublicDomain" data-req data-rule="host" placeholder="video.example.com">
            <span class="field-err"></span>
          </div>
        </div>
        <div class="grp-f">
          <label class="fl" for="r2AccessKeyId">Access key ID</label>
          <input id="r2AccessKeyId" data-req data-rule="nospace">
          <span class="field-err"></span>
        </div>
        <div class="grp-f">
          <div class="lrow"><label class="fl" for="r2SecretAccessKey">Secret access key</label><button type="button" class="reveal" data-reveal="r2SecretAccessKey">Show</button></div>
          <input id="r2SecretAccessKey" type="password" data-req data-rule="text">
          <p class="hint">We call <code>HeadBucket</code> to prove the key can read the bucket. The public media domain is <b>not</b> tested — get it wrong and video just won't play.</p>
          <span class="field-err"></span>
        </div>

        <h2 class="grp">Generated secrets</h2>
        <div class="derived">
          <div class="drow">
            <span class="k">MFA key</span>
            <span class="v muted"><span class="pill g">generated on save</span><br>32 bytes · encrypts TOTP secrets at rest · <code class="mono">MFA_ENCRYPTION_KEY</code></span>
          </div>
          <div class="drow">
            <span class="k">Settings key</span>
            <span class="v muted"><span class="pill g">generated on save</span><br>32 bytes · seals the mTLS private key and other stored settings · <code class="mono">SETTINGS_SECRET_ENCRYPTION_KEY</code></span>
          </div>
        </div>
        <div class="note warn">
          <b>Back up your <code>.env</code>.</b> Lose the settings key and every secret sealed in the database — including your mTLS private key — is unrecoverable.
        </div>
      </div>

      <div id="s1-testing" class="hidden">
        <ul class="tick" id="s1-tick">
          <li data-t="db"><span class="ti"></span><span>Database — connect, create, apply schema + seed, run migrations<span class="sub2" id="tk-db">—</span></span></li>
          <li data-t="redis"><span class="ti"></span><span>Redis — PING<span class="sub2" id="tk-redis">—</span></span></li>
          <li data-t="r2"><span class="ti"></span><span>Object storage — HeadBucket<span class="sub2" id="tk-r2">—</span></span></li>
          <li data-t="env"><span class="ti"></span><span>Writing <code>.env</code><span class="sub2">MFA_ENCRYPTION_KEY · SETTINGS_SECRET_ENCRYPTION_KEY</span></span></li>
        </ul>
      </div>

      <div id="s1-ready" class="hidden">
        <div class="token-chip" data-check>Infrastructure verified</div>
        <div class="checks" id="s1-checks"></div>
      </div>
    </section>

    <!-- ==================== STEP 2 — SITE ==================== -->
    <section class="panel" data-panel="1">
      <h1>Name this site</h1>
      <p class="sub">Everything else — your callback, event and key endpoints — derives from these. You'll paste them into your SSO in a moment.</p>

      <div class="grp-f">
        <label class="fl" for="siteName">Site name</label>
        <input id="siteName" data-req data-rule="sitename" placeholder="VideoSite">
        <p class="hint">Shown in the header, and registered at the SSO as this app's display name.</p>
        <span class="field-err"></span>
      </div>

      <div class="grp-f" style="max-width:440px">
        <label class="fl" for="siteHostname">Site address</label>
        <div class="compound">
          <select id="siteProtocol"><option value="https">https://</option><option value="http">http://</option></select>
          <input id="siteHostname" data-req data-rule="sitehost" placeholder="stream.example.com">
        </div>
        <p class="hint">A bare hostname — no scheme, no path. A non-standard port (<code>host:8443</code>) is allowed. Paste a URL and we'll trim it.</p>
        <span class="field-err"></span>
      </div>

      <h2 class="grp">Derived — you'll paste these at the SSO in step 5</h2>
      <div class="derived">
        <div class="derived-hd"><span class="t">Endpoints</span><span class="pill d">derived · not editable</span></div>
        <div class="drow"><span class="k">Sign-in callback</span><span class="v" id="d-cb">&mdash;</span></div>
        <div class="drow"><span class="k">Back-channel events</span><span class="v" id="d-bc">&mdash;</span></div>
        <div class="drow"><span class="k">Public key set</span><span class="v" id="d-jwks">&mdash;</span></div>
        <div class="drow"><span class="k">Post-logout</span><span class="v" id="d-pl">&mdash;</span></div>
      </div>
      <div class="note">
        These can't be edited, on purpose: they're the same strings you'll paste into the SSO's client record, so they can't drift out of sync. If one looks wrong, the hostname above is wrong — fix it <b>here</b>, not there.
      </div>
    </section>

    <!-- ==================== STEP 3 — SSO ==================== -->
    <section class="panel" data-panel="2">
      <h1>Connect to your SSO</h1>
      <p class="sub">videosite has no login page and no passwords of its own. Every sign-in happens at your SSO.</p>

      <div id="s3-form">
        <div class="grp-f">
          <label class="fl" for="ssoIssuer">Issuer</label>
          <input id="ssoIssuer" data-req data-rule="httpsurl" placeholder="https://sso.example.com">
          <p class="hint">The SSO's own base URL — the <code>iss</code> in its tokens.</p>
          <span class="field-err"></span>
          <p class="probe hidden" id="issuer-probe"></p>
        </div>
        <div class="grp-f">
          <label class="fl" for="ssoClientId">Client ID</label>
          <input id="ssoClientId" data-req data-rule="clientid" placeholder="videosite">
          <p class="hint">Must match exactly what you register at the SSO.</p>
          <span class="field-err"></span>
        </div>
        <div class="grp-f">
          <label class="fl" for="accountPortalUrl">Account portal <span class="opt">optional</span></label>
          <input id="accountPortalUrl" data-rule="httpsurl" placeholder="https://account.example.com">
          <p class="hint">Where users manage their password, MFA and devices.</p>
          <span class="field-err"></span>
        </div>
        <div class="note info">
          <b>Saving this step mints a key.</b> videosite generates its own Ed25519 signing key pair. The private half is written to this server and never leaves it; the public half is published at your <code>/.well-known/jwks.json</code> so the SSO can verify what we sign.
        </div>
      </div>

      <div id="s3-ready" class="hidden">
        <div class="token-chip" data-check>SSO saved · client key minted</div>
        <div class="checks" id="s3-checks"></div>
      </div>
    </section>

    <!-- ==================== STEP 4 — CERTIFICATE ==================== -->
    <section class="panel" data-panel="3">
      <h1>Client certificate</h1>
      <p class="sub"><b>Optional.</b> videosite presents this to the SSO on every server-to-server call once your edge enforces mTLS. Skip it and those calls simply go without one — step 5 works either way.</p>

      <div id="m-start">
        <div class="grp-f">
          <label class="fl" for="cn">Common name <span class="opt">optional</span></label>
          <input id="cn" placeholder="videosite-… (generated)">
          <p class="hint">Identifies this site on the certificate. Leave blank for a generated name.</p>
        </div>
        <button class="btn btn-ghost btn-wide" id="gen-csr" style="margin-top:4px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2 13 10"/><path d="m17 6 4 4"/><circle cx="7.5" cy="15.5" r="5.5"/></svg>
          Generate key &amp; signing request
        </button>
        <div class="note">Generates an ECDSA P-256 key on this server and a PKCS#10 signing request. <b>The private key never leaves this machine</b> — you only ever hand out the request.</div>
      </div>

      <div id="m-pending" class="hidden">
        <div class="grp-f">
          <div class="lrow"><label class="fl">Certificate signing request</label><button type="button" class="linkbtn" data-copy-el="csr">Copy</button></div>
          <textarea readonly id="csr"></textarea>
          <p class="hint">ECDSA P-256. Take this to your CA — in Cloudflare that's <b>SSL/TLS &rarr; Client Certificates &rarr; Create &rarr; "Use my private key and CSR"</b>.</p>
        </div>
        <div class="grp-f" id="cert-grp">
          <label class="fl" for="cert">Signed certificate</label>
          <textarea id="cert" placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"></textarea>
          <p class="hint">The leaf, or the full chain — order doesn't matter.</p>
          <span class="field-err" id="cert-err"></span>
        </div>
        <button class="btn btn-wide" id="install-cert">Install certificate</button>
        <p class="hint hint-c">Started this by mistake? <button type="button" class="linkbtn" data-act="cert-reset">Start over</button></p>
      </div>

      <div id="m-done" class="hidden">
        <div class="token-chip" data-check>Certificate installed</div>
        <div class="checks" id="m-checks"></div>
        <div class="note warn">
          <b>Enforcement is now on.</b> Harmless if your SSO doesn't ask for a client certificate. But if it asks for a <em>different</em> one, step 5's verify will fail at the TLS handshake — come back here and start over.
        </div>
        <p class="hint hint-c">Wrong certificate? <button type="button" class="linkbtn" data-act="cert-reset">Start over</button></p>
      </div>

      <div id="m-skipped" class="hidden">
        <div class="checks">
          <div class="chk"><span class="chk-ico wait"><svg viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg></span><div class="chk-body">
            <div class="chk-name">Skipped — no client certificate</div>
            <div class="chk-note">Server-to-server calls to the SSO go out without one. Fine unless your SSO's edge requires mutual TLS. Add it later in Admin &rarr; SSO.</div></div></div>
        </div>
        <p class="hint hint-c">Changed your mind? <button type="button" class="linkbtn" data-act="cert-start">Set one up now</button></p>
      </div>
    </section>

    <!-- ==================== STEP 5 — CONNECT & FINISH ==================== -->
    <section class="panel" data-panel="4">
      <h1 id="c-h1">Register this app at your SSO</h1>
      <p class="sub" id="c-sub">Your SSO doesn't hand out client IDs on its own. Add videosite to its client list, then come back — this page will keep checking.</p>

      <!-- pre-flight: can the world read our key set? -->
      <div id="c-pre">
        <p class="probe" id="preflight-ok"></p>
        <div class="diag amber hidden" id="preflight-bad"></div>
      </div>

      <!-- the 3-rung ladder: verifying / failed / verified -->
      <div id="c-ladder-wrap" class="hidden" style="margin-top:6px">
        <ol class="ladder" id="ladder">
          <li class="rung idle" data-r="1"><i></i><b>Reach the SSO</b><span></span><div class="dslot"></div></li>
          <li class="rung idle" data-r="2"><i></i><b>Prove our identity</b><span></span><div class="dslot"></div></li>
          <li class="rung idle" data-r="3"><i></i><b>Publish our roles</b><span></span><div class="dslot"></div></li>
        </ol>
        <p class="hint">One signed request proves everything at once: that the SSO knows us, that our key verifies, and that it accepted our role catalogue.</p>
      </div>

      <!-- the handoff sheet: stays on screen through failures -->
      <div id="c-sheet" style="margin-top:16px">
        <div class="handoff">
          <div class="t">Open the client list</div>
          <div class="d">At <span class="mono" id="h-issuer">your SSO</span> &rarr; Clients &rarr; New client. The form there asks for exactly the fields below, in this order. Nothing here is secret — the private key stays on this server.</div>
          <div class="acts">
            <a class="btn" id="open-sso" target="_blank" rel="noopener" href="#"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>Open the SSO admin</a>
            <button class="btn btn-ghost" data-copy-fn="all"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H7l-3 3z"/></svg>Copy all — send to your SSO admin</button>
            <button class="btn btn-ghost" data-copy-fn="json">Copy all as JSON</button>
          </div>
        </div>

        <div class="derived">
          <div class="derived-hd"><span class="t">Paste into the SSO's new-client form</span><span class="pill n">9 fields</span></div>
          <div id="sheet-rows"></div>
        </div>

        <details class="absurl">
          <summary>Your SSO wants absolute URLs, not a hostname and paths?</summary>
          <div class="derived" style="margin-top:8px" id="abs-rows"></div>
          <p class="hint" style="margin-left:2px">The same values, spelled out. All four derive from the hostname you set on step 2 — change it there and these change with it.</p>
        </details>

        <div class="note warn">
          <b>The SSO fetches your JWKS URL the moment you save the client.</b> This server is already serving it — so save the client while this page is open.
        </div>

        <p class="probe pending" id="wait-line" style="margin-top:14px">
          <span class="pd"></span>
          <span>Waiting for <span class="mono" id="wait-client">videosite</span> to appear at the SSO… <span style="color:#9ca3af" id="wait-age">not checked yet</span> · <button type="button" class="linkbtn" data-act="retry">check now</button></span>
        </p>
      </div>

      <!-- verified -->
      <div id="c-verified" class="hidden">
        <div class="derived" style="margin-bottom:4px">
          <div class="crow"><span class="ck">Registered</span><span class="cv" id="v-reg" style="font-family:inherit;font-size:12.5px;color:#1f2937"></span><button type="button" class="linkbtn" data-act="edit-client">Edit</button></div>
        </div>
        <div class="checks" id="v-checks"></div>
      </div>

      <!-- escape hatch: what replaces Skip -->
      <div class="note warn" id="c-escape">
        <b>Can't finish right now?</b> If you don't have SSO admin rights yet, use <em>Copy all</em> above, send it to whoever does, and leave. Everything you've entered is already saved — reopen <code id="c-installurl">/install</code> and you'll land back on this step.
      </div>
      <p class="navnote hidden" id="c-lock"><b>This locks the installer</b> — <code>/install</code> stops responding. Every setting here is editable afterwards in Admin &rarr; Settings and Admin &rarr; SSO.</p>
    </section>

    <!-- ==================== SUCCESS (panel 5, not in the stepper) ==================== -->
    <section class="panel" data-panel="5">
      <div class="done-badge"><svg viewBox="0 0 24 24" fill="none" stroke="#137333" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
      <h1 class="center" id="done-h1">videosite is live</h1>
      <p class="msg center">The SSO recognises this site, verified our signature, and accepted the role catalogue.</p>

      <div class="note info" id="done-admin"></div>

      <div class="handoff" style="margin-top:16px">
        <div class="t">Sign in</div>
        <div class="d">This is the address to hand out. It redirects to your SSO — there is no password to set here.</div>
        <div class="copyrow">
          <input class="mono" readonly value="" id="signin-url">
          <button class="btn btn-ghost" id="copy-signin">Copy</button>
        </div>
      </div>

      <div class="nav"><button class="btn btn-wide" id="go-signin">Go to sign-in</button></div>
    </section>

    <!-- nav -->
    <div class="nav" id="nav">
      <button class="btn btn-link" id="back" hidden>Back</button>
      <button class="btn btn-ghost" id="skip" hidden>Skip for now</button>
      <button class="btn" id="next">Continue</button>
    </div>
  </div>

  <p class="foot">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    <span id="foot-name">VideoSite</span> · first-run setup
  </p>
</div>`;

    // ========================================================================
    // SMALL HELPERS
    // ========================================================================
    var $ = function (id) { return document.getElementById(id); };
    var qsa = function (s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); };
    var esc = function (v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };
    var val = function (id) { var e = $(id); return e ? e.value.trim() : ''; };

    // Icons, injected once (the same trick the SSO/portal wizards use).
    var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="#065f46" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    var CHECKW = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    var INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2.4" stroke-linecap="round"><path d="M12 16v-5M12 8h.01"/><circle cx="12" cy="12" r="9"/></svg>';
    var TICKOK = '<svg viewBox="0 0 24 24" fill="none" stroke="#065f46" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    var TICKNO = '<svg viewBox="0 0 24 24" fill="none" stroke="#c5221f" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    var RUNGOK = '<svg viewBox="0 0 24 24" fill="none" stroke="#137333" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    var RUNGNO = '<svg viewBox="0 0 24 24" fill="none" stroke="#c5221f" stroke-width="3.2" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg>';
    var MOK = '<svg viewBox="0 0 24 24" fill="none" stroke="#065f46" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    var MNO = '<svg viewBox="0 0 24 24" fill="none" stroke="#c5221f" stroke-width="3.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    var COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

    function paintIcons(scope) {
        qsa('[data-check]', scope).forEach(function (e) {
            if (e.querySelector('svg')) return;
            e.insertAdjacentHTML('afterbegin', CHECK);
        });
        qsa('.ico-btn', scope).forEach(function (e) { if (!e.innerHTML.trim()) e.innerHTML = COPY; });
    }
    // Checklist rows are built here rather than hand-written, so every one of them
    // reports a REAL value.
    function chk(tone, name, value, note) {
        return '<div class="chk"><span class="chk-ico ' + tone + '">' + (tone === 'ok' ? CHECK : INFO) + '</span>' +
            '<div class="chk-body"><div class="chk-name">' + esc(name) + '</div>' +
            (value ? '<div class="chk-val">' + esc(value) + '</div>' : '') +
            (note ? '<div class="chk-note">' + note + '</div>' : '') +
            '</div></div>';
    }

    // --- the API. The install_token cookie authorises everything, so default
    // (same-origin) credentials are exactly right. Never throws on an HTTP error:
    // callers branch on .status and .body.
    async function api(method, url, body) {
        var opts = { method: method, headers: { Accept: 'application/json' } };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        try {
            var r = await fetch(url, opts);
            var data = null;
            if ((r.headers.get('content-type') || '').indexOf('application/json') !== -1) {
                data = await r.json().catch(function () { return null; });
            }
            return { ok: r.ok, status: r.status, body: data || {} };
        } catch (e) {
            // The infra step restarts pools mid-request; a dropped socket must not
            // look like a validation failure.
            return { ok: false, status: 0, body: {}, network: e.message || 'network error' };
        }
    }

    // ========================================================================
    // VALIDATION — mirrors routes/install.js exactly.
    //
    //   red ON BLUR, cleared on ANY edit, and the step's primary stays disabled
    //   until every required field on that step is valid.
    // ========================================================================
    var HOSTMSG = 'Enter a valid hostname (no scheme, no slashes, no path).';
    var RULES = {
        // A public DNS name. r2PublicDomain is cleanHost()ed on the server and
        // never charset-checked, but a media domain that isn't [a-z0-9.-] is a typo.
        host: function (v) { return /^[a-z0-9.-]+$/i.test(v) ? '' : HOSTMSG; },
        // routes/install.js site: cleanHost() then /^[a-z0-9.-]+(:\d{1,5})?$/i —
        // an explicit PORT is legal there, so it must be legal here.
        sitehost: function (v) {
            return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(v) ? '' : 'A bare hostname like stream.example.com — no scheme, no path.';
        },
        // DB / Redis hosts. The server does NO format check on these, so neither
        // may we: a compose service name can carry an underscore and an IPv6
        // literal is legal. Reject only what is certainly wrong.
        nethost: function (v) {
            if (/\s/.test(v)) return 'Cannot contain spaces.';
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.indexOf('/') !== -1) return 'A host only — no scheme, no path.';
            return '';
        },
        url: function (v) {
            try { var u = new URL(v); return /^https?:$/.test(u.protocol) ? '' : 'Enter a full URL, starting with https://'; }
            catch (e) { return 'Enter a full URL, starting with https://'; }
        },
        // routes/install.js httpsOk(): new URL(v).protocol === 'https:'
        httpsurl: function (v) {
            try { return new URL(v).protocol === 'https:' ? '' : 'Must be an https:// URL.'; }
            catch (e) { return 'Enter a full https:// URL, e.g. https://sso.example.com'; }
        },
        port: function (v) { return /^\d{1,5}$/.test(v) && +v <= 65535 ? '' : 'Digits only, 1–65535'; },
        nospace: function (v) { return /\s/.test(v) ? 'Cannot contain spaces.' : ''; },
        // /^[A-Za-z0-9_.-]{1,64}$/ — the server's exact client-id rule.
        clientid: function (v) {
            return /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? '' : 'Letters, digits, dot, dash and underscore only (1–64).';
        },
        sitename: function (v) { return v.length > 100 ? 'Site names are 100 characters or fewer.' : ''; },
        text: function () { return ''; },
    };
    function ruleMsg(inp) {
        if (!inp || inp.readOnly || inp.disabled) return '';
        var v = (inp.value || '').trim();
        if (!v) return inp.hasAttribute('data-req') ? 'Required' : '';
        return (RULES[inp.getAttribute('data-rule')] || RULES.text)(v);
    }
    function setBad(inp, m) {
        if (!inp) return;
        var g = inp.closest('.grp-f');
        if (!g) return;
        g.classList.add('bad');
        var s = g.querySelector('.field-err');
        if (s) s.innerHTML = m;
    }
    function clearBad(inp) { var g = inp && inp.closest('.grp-f'); if (g) g.classList.remove('bad'); }
    function stepValid(ids) {
        return ids.every(function (k) { return !ruleMsg($(k)); });
    }
    function paintErrors(ids) {
        var first = null;
        ids.forEach(function (k) {
            var m = ruleMsg($(k));
            if (m) { setBad($(k), m); if (!first) first = $(k); }
        });
        if (first) first.focus();
        return first;
    }
    // Server field errors: {errors:{<id>:"msg"}} — our input ids ARE the server's
    // field keys, so this maps 1:1. Focus the first bad one.
    function paintServerErrors(errors) {
        var first = null;
        Object.keys(errors || {}).forEach(function (k) {
            var e = $(k);
            if (!e) return;
            setBad(e, esc(errors[k]));
            if (!first) first = e;
        });
        if (first) first.focus();
        return first;
    }
    function showBanner(msg) {
        var b = $('banner');
        b.textContent = msg;
        b.classList.add('on');
    }

    var S1 = ['dbHost', 'dbPort', 'dbUser', 'dbPassword', 'dbName', 'redisHost', 'redisPort',
        'redisPassword', 'redisDb', 'r2Endpoint', 'r2BucketName', 'r2AccessKeyId',
        'r2SecretAccessKey', 'r2PublicDomain'];
    var S2 = ['siteName', 'siteHostname'];
    var S3 = ['ssoIssuer', 'ssoClientId', 'accountPortalUrl'];

    qsa('input[data-rule]').forEach(function (inp) {
        inp.addEventListener('blur', function () { var m = ruleMsg(inp); if (m) setBad(inp, m); });
        inp.addEventListener('input', function () { clearBad(inp); paintPrimary(); });
    });

    // Hostname fields take a paste of a full URL gracefully — the server would
    // strip it anyway (cleanHost), so do it here where the user can see it happen.
    ['siteHostname', 'r2PublicDomain'].forEach(function (id) {
        $(id).addEventListener('blur', function () {
            var stripped = this.value.trim().replace(/^https?:\/\//, '').split('/')[0];
            if (stripped !== this.value.trim()) { this.value = stripped; clearBad(this); derive(); }
        });
    });

    // ========================================================================
    // COPY / REVEAL
    // ========================================================================
    qsa('[data-reveal]').forEach(function (b) {
        b.addEventListener('click', function () {
            var e = $(b.getAttribute('data-reveal'));
            var show = e.type === 'password';
            e.type = show ? 'text' : 'password';
            b.textContent = show ? 'Hide' : 'Show';
        });
    });
    function flash(b) {
        if (b.classList.contains('ico-btn')) {
            b.classList.add('copied');
            setTimeout(function () { b.classList.remove('copied'); }, 1400);
            return;
        }
        var o = b.textContent;
        b.textContent = 'Copied';
        setTimeout(function () { b.textContent = o; }, 1400);
    }
    function copyText(t, b) {
        try { if (navigator.clipboard) navigator.clipboard.writeText(t); } catch (e) { /* optimistic */ }
        if (b) flash(b);
    }

    // ========================================================================
    // MODEL
    // ========================================================================
    var LAST = 4;          // Connect
    var SUCCESS = 5;       // success panel, not in the stepper
    var cur = 0;
    var model = {
        s1: 'pristine',              // pristine | testing | failed | ok
        s3: 'pristine',              // pristine | saved
        probe: null,                 // last /probe-sso result
        probing: false,
        cert: { phase: 'start', err: null, info: null, cn: '' },  // start|pending|installed|skipped
        skippedCert: false,
        s5: 'handoff',               // handoff | preflight | verifying | failed | verified
        connect: null,               // GET /api/install/connect
        verify: null,                // last failing verify response
        rung: 0,
        lastCheck: null,             // Date of the last verify attempt
        finish: null,                // POST /api/install/finish result
        busy: false,
    };

    // ========================================================================
    // STEP 2 — live derivation
    // ========================================================================
    function base() {
        var h = val('siteHostname');
        // An invalid hostname derives nothing — never show https://https://host/path.
        return h && !RULES.sitehost(h) ? $('siteProtocol').value + '://' + h : '';
    }
    function derive() {
        var b = base(), d = '—';
        $('d-cb').textContent = b ? b + '/auth/callback' : d;
        $('d-bc').textContent = b ? b + '/backchannel/events' : d;
        $('d-jwks').textContent = b ? b + '/.well-known/jwks.json' : d;
        $('d-pl').textContent = b ? b + '/' : d;
        var n = val('siteName');
        $('wordmark').firstChild.nodeValue = n || 'VideoSite';
        $('foot-name').textContent = n || 'VideoSite';
    }
    $('siteHostname').addEventListener('input', derive);
    $('siteName').addEventListener('input', derive);
    $('siteProtocol').addEventListener('change', derive);

    // ========================================================================
    // STEP 1 — infrastructure
    //
    // POST /api/install/infra is one slow call (probe DB + Redis + R2, schema,
    // seed, migrations, .env, adopt in-process), so the ticker cannot narrate it
    // live. It paces itself while the request is in flight and then resolves
    // against the real answer: on a 422/500 the erroring FIELD tells us which
    // stage broke, and the ticker stops there.
    // ========================================================================
    var TICK_STAGES = ['db', 'redis', 'r2', 'env'];
    var FIELD_STAGE = {
        dbHost: 'db', dbUser: 'db', dbPassword: 'db', dbName: 'db',
        redisHost: 'redis',
        r2Endpoint: 'r2', r2BucketName: 'r2', r2AccessKeyId: 'r2', r2SecretAccessKey: 'r2', r2PublicDomain: 'r2',
    };
    var tickTimer = null;

    function tickSet(stage, cls) {
        var li = $('s1-tick').querySelector('li[data-t="' + stage + '"]');
        if (!li) return;
        li.className = cls || '';
        li.querySelector('.ti').innerHTML = cls === 'ok' ? TICKOK : cls === 'bad' ? TICKNO : '';
    }
    function tickStart() {
        $('tk-db').textContent = val('dbHost') + ':' + (val('dbPort') || '3306') + ' · ' + val('dbName');
        $('tk-redis').textContent = val('redisHost') + ':' + (val('redisPort') || '6379') + ' · db ' + (val('redisDb') || '0');
        $('tk-r2').textContent = val('r2BucketName');
        TICK_STAGES.forEach(function (s) { tickSet(s, ''); });
        // Walk the spinner forward on a timer — it is a progress hint, not a claim.
        var i = 0;
        tickSet(TICK_STAGES[0], 'run');
        tickTimer = setInterval(function () {
            if (i >= TICK_STAGES.length - 1) return;
            tickSet(TICK_STAGES[i], 'ok');
            i++;
            tickSet(TICK_STAGES[i], 'run');
        }, 1200);
    }
    function tickStop(failStage) {
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
        var hit = failStage ? TICK_STAGES.indexOf(failStage) : TICK_STAGES.length;
        TICK_STAGES.forEach(function (s, i) {
            if (i < hit) tickSet(s, 'ok');
            else if (i === hit) tickSet(s, 'bad');
            else tickSet(s, '');
        });
    }

    async function submitInfra() {
        if (!stepValid(S1)) { paintErrors(S1); return; }
        model.s1 = 'testing';
        $('s1-dbprobe').classList.add('hidden');
        render();
        tickStart();

        var res = await api('POST', '/api/install/infra', {
            dbHost: val('dbHost'), dbPort: val('dbPort'), dbUser: val('dbUser'),
            dbPassword: $('dbPassword').value, dbName: val('dbName'),
            redisHost: val('redisHost'), redisPort: val('redisPort'),
            redisPassword: $('redisPassword').value, redisDb: val('redisDb'),
            r2Endpoint: val('r2Endpoint'), r2BucketName: val('r2BucketName'),
            r2AccessKeyId: val('r2AccessKeyId'), r2SecretAccessKey: $('r2SecretAccessKey').value,
            r2PublicDomain: val('r2PublicDomain'),
        });

        if (res.ok && res.body.ok) {
            tickStop(null);
            model.s1 = 'ok';
            renderS1Ready();
            render();
            return;
        }

        // Failure — nothing was written (or the write itself failed and said so).
        var errors = res.body.errors || {};
        var firstKey = Object.keys(errors)[0];
        tickStop(FIELD_STAGE[firstKey] || 'db');
        model.s1 = 'failed';
        render();

        if (firstKey) {
            paintServerErrors(errors);
            var p = $('s1-dbprobe');
            p.className = 'probe err';
            p.innerHTML = '<span class="pd"></span><span><b>Setup failed — nothing was written.</b><br>' +
                '<span class="mono" style="font-size:11.5px">' + esc(errors[firstKey]) + '</span></span>';
            p.classList.remove('hidden');
        } else {
            showBanner(res.network ? 'Lost contact with the server: ' + res.network : 'Setup failed. Check the server logs.');
        }
    }

    function renderS1Ready() {
        $('s1-checks').innerHTML =
            chk('ok', 'Database', val('dbHost') + ':' + (val('dbPort') || '3306') + ' · ' + val('dbName') + ' · schema, seed and migrations applied') +
            chk('ok', 'Redis', val('redisHost') + ':' + (val('redisPort') || '6379') + ' · db ' + (val('redisDb') || '0') + ' · reachable') +
            chk('ok', 'Object storage', val('r2BucketName') + ' · readable') +
            chk('ok', 'Encryption keys', 'MFA_ENCRYPTION_KEY · SETTINGS_SECRET_ENCRYPTION_KEY',
                'Generated and written to <code>.env</code>. Back that file up.') +
            chk('info', 'Public media domain', val('r2PublicDomain'), 'Not tested. Check it serves your bucket.');
    }

    // ========================================================================
    // STEP 2 — site
    // ========================================================================
    async function submitSite() {
        if (!stepValid(S2)) { paintErrors(S2); return; }
        model.busy = true; paintPrimary();
        var res = await api('POST', '/api/install/site', {
            siteName: val('siteName'),
            siteHostname: val('siteHostname'),
            siteProtocol: $('siteProtocol').value,
        });
        model.busy = false;

        if (res.ok && res.body.ok) { cur = 2; render(); return; }
        if (res.body.errors) { paintServerErrors(res.body.errors); paintPrimary(); return; }
        showBanner(res.network ? 'Lost contact with the server: ' + res.network : 'Could not save the site.');
        paintPrimary();
    }

    // ========================================================================
    // STEP 3 — SSO (probe on blur, save mints our client key)
    // ========================================================================
    $('ssoIssuer').addEventListener('blur', function () {
        var v = val('ssoIssuer');
        if (!v || RULES.httpsurl(v)) { model.probe = null; renderProbe(); return; }
        runProbe(v);
    });

    async function runProbe(url) {
        model.probing = true;
        model.probe = null;
        renderProbe();
        var res = await api('GET', '/api/install/probe-sso?url=' + encodeURIComponent(url));
        // A newer edit already superseded this probe — drop the stale answer.
        if (val('ssoIssuer') !== url) return;
        model.probing = false;
        model.probe = res.body || { ok: false, reason: 'unreachable' };
        renderProbe();
    }

    function renderProbe() {
        var p = $('issuer-probe');
        if (model.probing) {
            p.className = 'probe checking';
            p.innerHTML = '<span class="pd"></span><span>Reading discovery…</span>';
            return;
        }
        var r = model.probe;
        if (!r) { p.className = 'probe hidden'; p.innerHTML = ''; return; }

        if (r.ok) {
            p.className = 'probe ok';
            p.innerHTML = '<span class="pd"></span><span>Reachable — issuer matches.</span>';
        } else if (r.reason === 'issuer_mismatch') {
            p.className = 'probe warn';
            p.innerHTML = '<span class="pd"></span><span>That host advertises a different issuer: ' +
                '<span class="mono">' + esc(r.issuer) + '</span>. Tokens signed for it won\'t validate against what you typed. ' +
                '<button type="button" class="linkbtn" data-act="use-issuer" data-issuer="' + esc(r.issuer) + '">Use it instead</button></span>';
        } else if (r.reason === 'no_discovery') {
            p.className = 'probe warn';
            p.innerHTML = '<span class="pd"></span><span>Reached it, but <code>/.well-known/openid-configuration</code> didn\'t answer with an issuer' +
                (r.status ? ' (HTTP ' + esc(r.status) + ')' : '') + '. You can still save — but step 5 will fail until it does.</span>';
        } else if (r.reason === 'bad_url') {
            p.className = 'probe err';
            p.innerHTML = '<span class="pd"></span><span>That isn\'t an https:// URL.</span>';
        } else {
            p.className = 'probe warn';
            p.innerHTML = '<span class="pd"></span><span>Couldn\'t reach that host from this server (' + esc(r.reason || 'unreachable') +
                '). You can still save — but step 5 will fail until it is reachable.</span>';
        }
    }

    async function submitSso() {
        if (!stepValid(S3)) { paintErrors(S3); return; }
        model.busy = true; paintPrimary();
        var res = await api('POST', '/api/install/sso', {
            ssoIssuer: val('ssoIssuer'),
            ssoClientId: val('ssoClientId'),
            accountPortalUrl: val('accountPortalUrl'),
        });
        model.busy = false;

        if (res.ok && res.body.ok) {
            model.s3 = 'saved';
            renderS3Ready(res.body);
            render();
            return;
        }
        if (res.body.errors) { paintServerErrors(res.body.errors); paintPrimary(); return; }
        showBanner(res.network ? 'Lost contact with the server: ' + res.network : 'Could not save the SSO connection.');
        paintPrimary();
    }

    function renderS3Ready(r) {
        var jwks = base() + '/.well-known/jwks.json';
        $('s3-checks').innerHTML =
            chk('ok', 'SSO issuer', val('ssoIssuer')) +
            chk('ok', 'Client ID', r.clientId || val('ssoClientId')) +
            (val('accountPortalUrl') ? chk('ok', 'Account portal', val('accountPortalUrl'))
                : chk('info', 'Account portal', 'Not set', 'Users will have nowhere to manage their password, MFA or devices. Add it later in Admin &rarr; SSO.')) +
            chk('ok', 'Client key', 'EdDSA · kid ' + (r.kid || '—') + (r.created ? ' · minted just now' : ' · already present'),
                'Private half on this server only. Back-navigation never re-mints it — the SSO may already have read it.') +
            chk('info', 'Published at', jwks,
                'The SSO fetches this the moment you register the client, which is why we mint the key <em>before</em> you go there.');
    }

    // ========================================================================
    // STEP 4 — client certificate (optional)
    // ========================================================================
    async function loadMtls() {
        var res = await api('GET', '/api/install/mtls');
        if (!res.ok) return;
        var s = res.body || {};
        if (s.state === 'configured') {
            model.cert = { phase: 'installed', err: null, info: s, cn: s.cn || '' };
            renderCertDone(s);
        } else if (model.cert.phase !== 'skipped' && model.cert.phase !== 'pending') {
            // A pending key with no CSR in this page's memory (a reload) is not
            // recoverable — the server hands out the CSR once. Generating again
            // simply replaces the pending key, so start over.
            model.cert.phase = 'start';
        }
        render();
    }

    async function genCsr() {
        model.busy = true; paintPrimary();
        var res = await api('POST', '/api/install/mtls/csr', { cn: val('cn') });
        model.busy = false;
        if (!res.ok) {
            showBanner('Could not generate the signing request: ' + esc(res.body.detail || res.network || 'unknown error'));
            paintPrimary();
            return;
        }
        model.cert = { phase: 'pending', err: null, info: null, cn: res.body.cn || '' };
        $('csr').value = res.body.csr || '';
        $('cert').value = '';
        render();
        setTimeout(function () { $('cert').focus(); }, 60);
    }

    // Every rejection reason the service can return gets its own message — the
    // difference between "wrong PEM" and "certificate for somebody else's key"
    // is the difference between a retry and a restart.
    var CERT_ERR = {
        key_mismatch: 'This certificate wasn\'t issued from the request above — its public key doesn\'t match the private key we generated. Sign <em>our</em> CSR; don\'t upload a certificate from somewhere else.',
        parse_failed: 'That doesn\'t look like a PEM certificate. It should start with <span class="mono">-----BEGIN CERTIFICATE-----</span>.',
        expired: 'That certificate has already expired.',
        no_key: 'The signing request is gone — did the server restart? Start over.',
        no_cert: 'Paste the certificate your CA issued.',
    };

    async function installCert() {
        var pem = $('cert').value.trim();
        if (!pem) { model.cert.err = 'no_cert'; render(); return; }
        model.busy = true; paintPrimary();
        var res = await api('POST', '/api/install/mtls/cert', { cert: pem });
        model.busy = false;

        if (res.ok && res.body.ok) {
            model.cert = { phase: 'installed', err: null, info: res.body, cn: res.body.cn || '' };
            model.skippedCert = false;
            renderCertDone(res.body);
            render();
            return;
        }
        if (res.status === 422) {
            model.cert.err = res.body.reason || 'parse_failed';
            render();
            return;
        }
        showBanner('Could not install the certificate: ' + esc(res.body.detail || res.network || 'unknown error'));
        paintPrimary();
    }

    async function resetCert(nextPhase) {
        model.busy = true; paintPrimary();
        await api('DELETE', '/api/install/mtls');
        model.busy = false;
        model.cert = { phase: nextPhase || 'start', err: null, info: null, cn: '' };
        $('csr').value = '';
        $('cert').value = '';
        render();
    }

    function renderCertDone(s) {
        var left = '';
        if (s.not_after) {
            var days = Math.round((new Date(s.not_after) - Date.now()) / 86400000);
            left = days < 0 ? '<span class="pill r">expired</span>'
                : days > 400 ? '<span class="pill g">' + Math.floor(days / 365) + ' years left</span>'
                    : '<span class="pill ' + (days < 30 ? 'y' : 'g') + '">' + days + ' days left</span>';
        }
        $('m-checks').innerHTML =
            chk('ok', 'Subject', 'CN=' + (s.cn || '—')) +
            chk('ok', 'Issued by', s.issuer || '—') +
            '<div class="chk"><span class="chk-ico ok">' + CHECK + '</span><div class="chk-body">' +
            '<div class="chk-name">Expires</div><div class="chk-val">' +
            esc(s.not_after ? new Date(s.not_after).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—') +
            ' ' + left + '</div></div></div>' +
            chk('info', 'Presentation', 'Presented on every server-to-server call');
    }

    // ========================================================================
    // STEP 5 — connect: pre-flight, paste sheet, the 3-rung ladder, finish
    // ========================================================================
    async function loadConnect() {
        var res = await api('GET', '/api/install/connect');
        if (!res.ok) {
            showBanner('Could not read the connection details: ' + esc(res.body.detail || res.network || 'unknown error'));
            return;
        }
        model.connect = res.body;
        // A pre-flight failure means the SSO will not be able to fetch our key set
        // the moment the operator saves the client — say so before they go there.
        if (model.s5 === 'handoff' || model.s5 === 'preflight') {
            model.s5 = (model.connect.preflight && model.connect.preflight.ok) ? 'handoff' : 'preflight';
        }
        renderSheet();
        render();
    }

    function C() { return model.connect || {}; }
    function jwksUrl() { return (C().derived && C().derived.jwks) || ''; }

    // The nine fields, straight from the server's own values — no client-side
    // re-derivation, so the sheet and the SSO can't disagree.
    function sheetRows() {
        var c = C(), d = c.derived || {}, p = c.paths || {};
        return [
            ['Client ID', c.clientId || ''],
            ['Name', c.siteName || ''],
            ['Hostname', c.hostname || ''],
            ['Redirect path', p.redirect || '/auth/callback'],
            ['Events path', p.events || '/backchannel/events'],
            ['JWKS URL', d.jwks || ''],
        ];
    }
    function renderSheet() {
        var c = C(), d = c.derived || {};
        var rows = sheetRows().map(function (r) {
            return '<div class="crow"><span class="ck">' + esc(r[0]) + '</span>' +
                '<input class="cv" readonly value="' + esc(r[1]) + '">' +
                '<button type="button" class="ico-btn" data-copy="' + esc(r[1]) + '" title="Copy"></button></div>';
        }).join('');
        rows += '<div class="crow"><span class="ck">Allowed scopes</span><span class="cv" style="display:flex;gap:5px">' +
            '<span class="pill n">openid</span><span class="pill n">profile</span><span class="pill n">email</span></span></div>' +
            '<div class="crow"><span class="ck">First-party</span><span class="cv" style="font-family:inherit;font-size:12px;color:#6b7280">' +
            '<span class="pill g">Yes</span> tick it</span></div>' +
            '<div class="crow" style="align-items:flex-start"><span class="ck" style="padding-top:2px">Entry policy</span>' +
            '<span class="cv" style="font-family:inherit;font-size:12px;color:#6b7280;line-height:1.5;white-space:normal">' +
            '<span class="pill d">Opt-in</span> only users you grant access can sign in. Choose <b>Baseline</b> only if every SSO user should have this site.</span></div>';
        $('sheet-rows').innerHTML = rows;

        $('abs-rows').innerHTML = [
            ['Callback URL', d.callback || ''],
            ['Events URL', d.events || ''],
            ['JWKS URL', d.jwks || ''],
            ['Post-logout', c.base ? c.base + '/' : ''],
        ].map(function (r) {
            return '<div class="crow"><span class="ck">' + esc(r[0]) + '</span>' +
                '<input class="cv" readonly value="' + esc(r[1]) + '">' +
                '<button type="button" class="ico-btn" data-copy="' + esc(r[1]) + '" title="Copy"></button></div>';
        }).join('');

        $('h-issuer').textContent = c.issuer || 'your SSO';
        $('wait-client').textContent = c.clientId || 'videosite';
        $('open-sso').href = c.issuer ? c.issuer + '/admin/clients' : '#';
        $('c-installurl').textContent = (c.base || '') + '/install';
        paintIcons($('c-sheet'));
    }

    function copySheetText() {
        return 'Register this app in the SSO admin (Clients → New client):\n\n' +
            sheetRows().concat([
                ['Allowed scopes', 'openid profile email'],
                ['First-party', 'yes'],
                ['Entry policy', 'opt_in'],
            ]).map(function (r) { return (r[0] + '                ').slice(0, 16) + r[1]; }).join('\n') +
            '\n\nThe SSO fetches the JWKS URL the moment the client is saved.';
    }
    function copySheetJson() {
        var c = C(), d = c.derived || {}, p = c.paths || {};
        return JSON.stringify({
            client_id: c.clientId,
            name: c.siteName,
            hostname: c.hostname,
            redirect_paths: [p.redirect || '/auth/callback'],
            events_path: p.events || '/backchannel/events',
            jwks_uri: d.jwks,
            allowed_scopes: ['openid', 'profile', 'email'],
            is_first_party: true,
            entry_policy: 'opt_in',
        }, null, 2);
    }

    // --- pre-flight ---------------------------------------------------------
    var PREFLIGHT_WHY = {
        not_serving: 'answered HTTP {status} instead of our key set',
        no_keys: 'answered, but with an empty key set',
        timeout: 'did not answer within 6 seconds',
        unreachable: 'could not be reached from this server',
        no_hostname: 'has no hostname yet — set one on step 2',
    };
    function renderPreflight() {
        var pf = (C().preflight) || {};
        var okEl = $('preflight-ok'), badEl = $('preflight-bad');
        if (pf.ok) {
            okEl.className = 'probe ok';
            okEl.innerHTML = '<span class="pd"></span><span>Pre-flight: your key set answers at <span class="mono">' + esc(pf.url) +
                '</span> (' + esc(pf.keys) + ' key' + (pf.keys === 1 ? '' : 's') + ', kid <span class="mono">' + esc(pf.kid) +
                '</span>) — the SSO will be able to fetch it.</span>';
            okEl.classList.remove('hidden');
            badEl.classList.add('hidden');
            return;
        }
        okEl.classList.add('hidden');
        var why = (PREFLIGHT_WHY[pf.reason] || 'could not be read').replace('{status}', esc(pf.status));
        badEl.innerHTML =
            '<div class="diag-h"><span>Stop — the SSO won\'t be able to reach you</span>' +
            '<span class="codes"><code>' + esc(pf.reason || 'unreachable') + '</code></span></div>' +
            '<p>We tried to fetch our own key set at <code>' + esc(pf.url || (C().base || '') + '/.well-known/jwks.json') +
            '</code> and it ' + why + '. The SSO fetches that URL the instant you save the client, so registration will fail. ' +
            'Fix DNS / your reverse proxy first.' + (pf.detail ? ' <code>' + esc(pf.detail) + '</code>' : '') + '</p>' +
            '<div class="diag-a">' +
            '<button type="button" class="btn btn-sm" data-act="preflight-retry">Check again</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="edit-hostname">Fix the hostname (step 2)</button>' +
            '</div>';
        badEl.classList.remove('hidden');
    }

    // --- the ladder ---------------------------------------------------------
    // stage -> rung. The server tells us WHICH rung failed, and that is the whole
    // point of the ladder: a 'roles' failure means rungs 1 and 2 are GREEN and the
    // problem is on THIS server, not at the SSO.
    var STAGE_RUNG = { reach: 1, identity: 2, sign: 2, roles: 3 };

    // …with two exceptions. installVerify.js returns stage 'roles'/'sign' for two
    // failures that never leave this server: composeRolesPayload() threw
    // (roles_unavailable) or signEventToken() threw (sign_failed). No request was
    // sent, so the rungs BELOW them proved nothing and must stay IDLE — greening
    // them would tell the operator the SSO recognised us when we never called it.
    var LOCAL_FAIL = { roles_unavailable: 1, sign_failed: 1 };

    function rungSub(n) {
        var c = C(), roles = (model.verify && model.verify.roles) || (model.finish && model.finish.roles) || null;
        if (n === 1) return (c.issuer || 'the SSO') + ' — discovery reachable, issuer matches';
        if (n === 2) return 'EdDSA · kid ' + ((c.key && c.key.kid) || '—') + ' → POST /backchannel/events';
        var count = roles && roles.roles ? roles.roles.length : null;
        var def = roles && roles.roles ? (roles.roles.filter(function (r) { return r.role_id === roles.default_role; })[0] || {}).name : null;
        return (count != null ? count + ' roles' : 'role catalogue') +
            (def ? ' · default = ' + def : '') +
            ' · display name = "' + (c.siteName || '') + '"';
    }

    function paintLadder() {
        var fail = model.s5 === 'failed' ? model.verify : null;
        var failRung = fail ? (STAGE_RUNG[fail.stage] || 2) : 0;
        var local = !!(fail && LOCAL_FAIL[fail.reason]);

        qsa('.rung').forEach(function (li) {
            var n = +li.getAttribute('data-r');
            li.className = 'rung idle';
            li.querySelector('i').innerHTML = '';
            li.querySelector('span').textContent = rungSub(n);
            li.querySelector('.dslot').innerHTML = '';

            if (model.s5 === 'verified') {
                li.className = 'rung ok';
                li.querySelector('i').innerHTML = RUNGOK;
            } else if (model.s5 === 'verifying') {
                if (n < model.rung) { li.className = 'rung ok'; li.querySelector('i').innerHTML = RUNGOK; }
                else if (n === model.rung) { li.className = 'rung run'; }
            } else if (fail) {
                if (n < failRung && !local) { li.className = 'rung ok'; li.querySelector('i').innerHTML = RUNGOK; }
                else if (n === failRung) {
                    var d = diagnose(fail);
                    li.className = 'rung fail';
                    li.querySelector('i').innerHTML = RUNGNO;
                    li.querySelector('span').textContent = d.rungSub;
                    li.querySelector('.dslot').innerHTML = diagHTML(d, fail);
                    paintIcons(li);
                }
            }
        });
    }

    var INL = function (v) {
        return '<span class="inl"><input class="mono" readonly value="' + esc(v) + '">' +
            '<button type="button" class="ico-btn" data-copy="' + esc(v) + '"></button></span>';
    };

    // Every failure the API can hand back, mapped to its rung, its diagnosis and
    // its recovery. Interpolated with real values — nothing here is invented.
    function diagnose(f) {
        var c = C();
        var jwks = jwksUrl();
        var clientId = c.clientId || 'videosite';
        var issuer = c.issuer || '';
        var kid = (c.key && c.key.kid) || '—';
        var pf = c.preflight || {};
        var http = f.status ? 'HTTP ' + f.status : (LOCAL_FAIL[f.reason] ? 'not sent' : 'no response');
        var RETRY = '<button type="button" class="btn btn-sm" data-act="retry">Check again</button>';

        if (f.stage === 'reach') {
            return {
                rungSub: f.reason === 'timeout' ? 'no answer within 6 seconds' : 'the SSO refused or dropped the connection',
                code: f.reason === 'timeout' ? 'ETIMEDOUT' : 'connection failed',
                http: 'no response',
                body: '<p>We never got an answer from <code>' + esc(issuer) + '/backchannel/events</code>' +
                    (f.detail ? ' — <code>' + esc(f.detail) + '</code>' : '') + '. Nothing reached the SSO at all, so there is no JSON error to read: ' +
                    'this is DNS, a firewall, TLS — or, if the SSO\'s edge enforces mutual TLS, a client certificate it refused.</p>' +
                    '<ol class="fix"><li>Confirm the issuer you set on step 3:' + INL(issuer) + '</li>' +
                    '<li>From this server, check DNS and that port 443 is open to the SSO.</li>' +
                    '<li>If your SSO is behind mutual TLS, set up the client certificate and present one its edge trusts.' +
                    (model.cert.phase === 'installed' ? ' You installed <code>CN=' + esc(model.cert.cn) + '</code> — if its edge doesn\'t trust that CA, this is exactly what you\'d see.' : '') +
                    '</li></ol>',
                acts: RETRY +
                    '<button type="button" class="btn btn-ghost btn-sm" data-act="cert">Set up the client certificate</button>' +
                    '<button type="button" class="btn btn-ghost btn-sm" data-act="edit-issuer">Edit the issuer</button>' +
                    '<button type="button" class="btn btn-ghost btn-sm" data-act="diag">Copy diagnostics</button>',
            };
        }

        if (f.reason === 'unknown_client') {
            return {
                rungSub: 'the SSO has no client called "' + clientId + '"',
                code: 'unknown_client', http: http,
                body: '<p>It hasn\'t been added yet, or the Client ID doesn\'t match exactly — the SSO is character-sensitive. It can also mean the client exists but is <b>disabled</b> there.</p>' +
                    '<ol class="fix"><li>Open the SSO admin → Clients → New client and paste the nine fields from the sheet below.</li>' +
                    '<li>Check the Client ID character-for-character. It must be exactly:' + INL(clientId) + '</li>' +
                    '<li>If the client does exist, check it isn\'t <b>disabled</b> — a disabled client reports as unknown.</li></ol>',
                acts: RETRY +
                    '<button type="button" class="btn btn-ghost btn-sm" data-act="edit-client">Edit the Client ID</button>' +
                    '<button type="button" class="btn btn-ghost btn-sm" data-act="open-sso">Open the SSO admin</button>' +
                    '<button type="button" class="btn btn-ghost btn-sm" data-act="diag">Copy diagnostics</button>',
            };
        }

        if (f.reason === 'no_registered_key') {
            return {
                rungSub: 'client found — but it has no JWKS URL on the record',
                code: 'no_registered_key', http: http,
                body: '<p>The client record has no <b>JWKS URL</b>, so the SSO can\'t verify anything we sign. Edit the client and set its JWKS URL to <code>' + esc(jwks) + '</code>' +
                    (pf.ok ? ' — we just checked that URL from here and it answers with ' + esc(pf.keys) + ' key (kid <code>' + esc(pf.kid) + '</code>), so it will work.' : '.') + '</p>' +
                    '<ol class="fix"><li>Open the <b>' + esc(clientId) + '</b> client at the SSO (the field may sit under "Keys" or "Advanced").</li>' +
                    '<li>Paste this and save:' + INL(jwks) + '</li>' +
                    '<li>Come back and check again. Nothing changes on this side.</li></ol>',
                acts: RETRY +
                    '<button type="button" class="btn btn-ghost btn-sm" data-copy="' + esc(jwks) + '">Copy JWKS URL</button>' +
                    '<button type="button" class="btn btn-ghost btn-sm" data-act="open-sso">Open the client at the SSO</button>',
            };
        }

        if (f.reason === 'invalid_token') {
            // Signature, unknown kid, an unreachable JWKS URL, issuer, audience and
            // clock skew all collapse to this one code at the SSO. Lay out what we
            // KNOW from our side so the operator can see which half is suspect.
            return {
                rungSub: 'signature rejected — the SSO checked it against a different key',
                code: 'invalid_token', http: http,
                body: '<p>Signature, unknown kid, an unreachable JWKS URL, issuer, audience and clock skew all collapse to this one code at the SSO. Here is everything true on <b>our</b> side — if it all checks out, the key the SSO holds for us is the odd one out:</p>' +
                    '<ul class="subchk">' +
                    '<li><span class="m ok">' + MOK + '</span><div><b>Our key</b><span class="why">We sign with kid <span class="mono">' + esc(kid) + '</span> (EdDSA).</span></div></li>' +
                    (pf.ok
                        ? '<li><span class="m ok">' + MOK + '</span><div><b>The key set we publish</b><span class="why"><span class="mono">' + esc(pf.url) + '</span> answers with ' + esc(pf.keys) + ' key (kid <span class="mono">' + esc(pf.kid) + '</span>).</span></div></li>'
                        : '<li class="no"><span class="m no">' + MNO + '</span><div><b>The key set we publish</b><span class="why"><span class="mono">' + esc(pf.url || jwks) + '</span> did not answer (' + esc(pf.reason || 'unreachable') + '). The SSO can\'t read our key either — fix this first.</span></div></li>') +
                    '<li><span class="m ok">' + MOK + '</span><div><b>Issuer / audience</b><span class="why">We address <span class="mono">' + esc(issuer) + '</span>.</span></div></li>' +
                    '<li><span class="m ok">' + MOK + '</span><div><b>iss = sub = client_id</b><span class="why"><span class="mono">' + esc(clientId) + '</span> throughout.</span></div></li>' +
                    '</ul>' +
                    '<ol class="fix"><li>Open the <b>' + esc(clientId) + '</b> client at the SSO and check its JWKS URL is exactly:' + INL(jwks) + '</li>' +
                    '<li>If it points anywhere else, the SSO is checking our signature against somebody else\'s key. Fix it there, then check again — nothing needs to change on this side.</li>' +
                    '<li>If it is already correct, check this server\'s clock: tokens are rejected past a few minutes of skew.</li></ol>',
                acts: RETRY +
                    '<button type="button" class="btn btn-ghost btn-sm" data-copy="' + esc(jwks) + '">Copy our JWKS URL</button>' +
                    '<button type="button" class="btn btn-ghost btn-sm" data-act="open-jwks">Open our JWKS</button>' +
                    '<button type="button" class="btn btn-ghost btn-sm" data-act="edit-issuer">Edit the issuer</button>',
            };
        }

        // installVerify.js returns stage 'roles' for this too, but it is NOT the
        // same failure: composeRolesPayload() threw, so no request ever left this
        // server. Saying "the SSO refused the catalogue" would be a lie.
        if (f.reason === 'roles_unavailable') {
            return {
                rungSub: 'this server could not read its own role catalogue',
                code: 'roles_unavailable', http: http,
                body: '<p><b>Nothing was sent to the SSO.</b> We could not assemble the role catalogue out of this server\'s own database, so there was nothing to sign and nothing to publish' +
                    (f.detail ? ' — <code>' + esc(f.detail) + '</code>' : '') + '. This is a fault on <b>this</b> side, not at the SSO, and not something you mistyped.</p>' +
                    '<ol class="fix"><li>Check again — a transient database read can cause it.</li>' +
                    '<li>If it repeats, the schema from step 1 did not land cleanly. This server\'s logs and its <code>roles</code> table are where to look.</li></ol>',
                acts: RETRY + '<button type="button" class="btn btn-ghost btn-sm" data-act="diag">Copy diagnostics</button>',
            };
        }

        if (f.stage === 'roles') {
            // The SSO ACCEPTS us and rejected our catalogue. Rungs 1 and 2 are green.
            // This is a problem with THIS server's role table, not with the SSO.
            return {
                rungSub: 'the SSO refused the role catalogue',
                code: f.reason, http: http,
                body: '<ul class="subchk">' +
                    '<li><span class="m ok">' + MOK + '</span><div><b>Client recognised</b><span class="why">The SSO knows <span class="mono">' + esc(clientId) + '</span>.</span></div></li>' +
                    '<li><span class="m ok">' + MOK + '</span><div><b>Signature verified</b><span class="why">Our key checked out against the registered JWKS.</span></div></li>' +
                    '<li class="no"><span class="m no">' + MNO + '</span><div><b>Role catalogue rejected</b><span class="why"><span class="mono">' + esc(f.reason) + '</span>' +
                    (f.detail ? ' — ' + esc(f.detail) : '') + '</span></div></li>' +
                    '</ul>' +
                    '<p style="margin-top:11px"><b>This is not your fault, and nothing is wrong with the connection.</b> That\'s a seed/migration problem on <b>this</b> server, not a mistake you made at the SSO.</p>' +
                    '<ol class="fix"><li>Try again — a transient read can cause it.</li>' +
                    '<li>If it repeats, copy the diagnostics and file them. The role table needs fixing before this site can finish setup.</li></ol>',
                acts: '<button type="button" class="btn btn-sm" data-act="retry">Try again</button>' +
                    '<button type="button" class="btn btn-ghost btn-sm" data-act="diag">Copy diagnostics</button>',
            };
        }

        // stage 'sign' (sign_failed), and any http_<n> the SSO invents.
        return {
            rungSub: f.stage === 'sign' ? 'we could not sign the request' : 'the SSO rejected us (' + f.reason + ')',
            code: f.reason, http: http,
            body: '<p>' + (f.stage === 'sign'
                ? 'This server could not sign the request with its own client key. That is a fault on <b>this</b> side — the key may be missing or unreadable. Go back to step 3 and save it again to re-mint it.'
                : 'The SSO answered <code>' + esc(f.reason) + '</code>, which the installer doesn\'t have a specific diagnosis for. Its own logs will say more.') +
                (f.detail ? ' <code>' + esc(f.detail) + '</code>' : '') + '</p>',
            acts: RETRY + '<button type="button" class="btn btn-ghost btn-sm" data-act="diag">Copy diagnostics</button>',
        };
    }

    // The exact request we sent, reconstructed from real values — the operator can
    // hand this straight to whoever runs the SSO.
    function requestDump() {
        var c = C(), roles = (model.verify && model.verify.roles) || {};
        var kid = (c.key && c.key.kid) || '—';
        return 'POST ' + (c.issuer || '') + '/backchannel/events\n' +
            'Content-Type: application/x-www-form-urlencoded\n' +
            (model.cert.phase === 'installed' ? 'Client-Cert: CN=' + model.cert.cn + '\n' : '') +
            '\nevent_token=<JWT>\n\n' +
            '  header  { "alg":"EdDSA", "kid":"' + kid + '", "typ":"events+jwt" }\n' +
            '  claims  { "iss":"' + (c.clientId || '') + '", "sub":"' + (c.clientId || '') + '",\n' +
            '            "aud":"' + (c.issuer || '') + '",\n' +
            '            "events":[{ "type":"roles.sync", "payload":\n' +
            JSON.stringify(roles, null, 2).split('\n').map(function (l) { return '              ' + l; }).join('\n') + ' }] }';
    }
    function diagnostics() {
        var f = model.verify || {}, c = C();
        return JSON.stringify({
            stage: f.stage, reason: f.reason, status: f.status, detail: f.detail,
            issuer: c.issuer, client_id: c.clientId, jwks_uri: jwksUrl(),
            kid: c.key && c.key.kid, preflight: c.preflight,
            mtls: model.cert.phase === 'installed' ? { cn: model.cert.cn } : null,
            roles: f.roles,
            at: new Date().toISOString(),
        }, null, 2);
    }
    // The diagnosis block. It renders INSIDE the failing rung (.dslot) — never in
    // a banner — so the red rung and its explanation are the same object.
    function diagHTML(d, f) {
        return '<div class="diag">' +
            '<div class="diag-h"><span>' + diagTitle(f) + '</span>' +
            '<span class="codes"><code>' + esc(d.code) + '</code><code>' + esc(d.http) + '</code></span></div>' +
            d.body +
            // No request left the server on a LOCAL_FAIL — don't show one.
            (LOCAL_FAIL[f.reason] ? '' : '<details><summary>Show the exact request we sent</summary><pre>' + esc(requestDump()) + '</pre></details>') +
            '<div class="diag-a">' + d.acts + '</div>' +
            '</div>';
    }
    function diagTitle(f) {
        var c = C();
        if (f.stage === 'reach') return 'Couldn\'t reach ' + esc(c.issuer || 'the SSO') + '/backchannel/events';
        if (f.reason === 'unknown_client') return 'The SSO has never heard of a client called ' + esc(c.clientId || 'videosite');
        if (f.reason === 'no_registered_key') return 'Good news: the SSO found ' + esc(c.clientId || 'videosite') + '. It just has no key.';
        if (f.reason === 'invalid_token') return 'The SSO couldn\'t verify our signature';
        if (f.reason === 'roles_unavailable') return 'We couldn\'t read our own role catalogue';
        if (f.stage === 'roles') return 'Connected — but the SSO couldn\'t apply our role catalogue';
        if (f.stage === 'sign') return 'We couldn\'t sign the request';
        return 'The SSO rejected us';
    }

    // --- verify -------------------------------------------------------------
    // Walk the rungs while the single request is in flight — it either comes back
    // 204 (all three green) or tells us which rung broke.
    async function doVerify() {
        if (model.s5 === 'verifying') return;
        model.s5 = 'verifying';
        model.rung = 1;
        model.verify = null;
        model.lastCheck = new Date();
        render();

        var walk = setInterval(function () {
            if (model.rung < 3) { model.rung++; paintLadder(); }
        }, 600);

        var res = await api('POST', '/api/install/verify');
        clearInterval(walk);

        if (res.ok && res.body.ok) {
            model.verify = res.body;
            model.s5 = 'verified';
            renderVerified(res.body);
            render();
            return;
        }
        // A network failure looks exactly like never reaching the SSO — say so
        // in the same shape rather than inventing a new state.
        model.verify = res.body && res.body.stage
            ? res.body
            : { ok: false, stage: 'reach', reason: 'unreachable', detail: res.network || 'the installer could not reach this server' };
        model.s5 = 'failed';
        render();
    }

    function renderVerified(r) {
        var c = C(), roles = r.roles || {};
        var list = roles.roles || [];
        var def = list.filter(function (x) { return x.role_id === roles.default_role; })[0];
        var ssoHost = (c.issuer || '').replace(/^https?:\/\//, '');
        $('v-reg').innerHTML = 'as <span class="mono">' + esc(c.clientId) + '</span> at <span class="mono">' + esc(ssoHost) + '</span>';
        $('v-checks').innerHTML =
            chk('ok', 'Connected', (c.issuer || '').replace(/^https?:\/\//, '') + ' · discovery OK') +
            chk('ok', 'Identity verified', 'client "' + (c.clientId || '') + '" · our key kid ' + ((c.key && c.key.kid) || '—') + ' accepted') +
            chk('ok', 'Roles published',
                list.length + ' roles' + (def ? ' · default "' + def.name + '"' : '') + ' · display name "' + (c.siteName || '') + '"',
                esc(list.map(function (x) { return x.name; }).join(', ')) + '. The SSO acknowledged (<code>204</code>).') +
            (model.cert.phase === 'installed'
                ? chk('ok', 'Client certificate', 'CN=' + model.cert.cn + ' · presented on server-to-server calls')
                : chk('info', 'Client certificate', 'Not configured — server-to-server calls go without one.')) +
            chk('info', 'Sign-in redirect', (c.derived && c.derived.callback) || '',
                'Not testable from here. Verify exercises the event channel (us &rarr; the SSO); it cannot prove the redirect URI is registered. If sign-in bounces, check this at the SSO first.');
    }

    // --- finish -------------------------------------------------------------
    // finish() re-verifies server-side. If that second verify fails we drop right
    // back onto the failed ladder — the gate holds even if the world moved under us.
    async function doFinish() {
        model.busy = true;
        paintPrimary();
        var res = await api('POST', '/api/install/finish', { skippedCert: model.skippedCert });
        model.busy = false;

        if (res.ok && res.body.ok) {
            model.finish = res.body;
            renderDone(res.body);
            cur = SUCCESS;
            render();
            return;
        }
        if (res.status === 422 && res.body.stage) {
            model.verify = res.body;
            model.s5 = 'failed';
            render();
            showBanner('The SSO no longer accepts us — the installer re-checks on finish, and this time it failed.');
            return;
        }
        showBanner('Could not finish: ' + esc((res.body && (res.body.detail || res.body.error)) || res.network || 'unknown error'));
        paintPrimary();
    }

    function renderDone(r) {
        var c = C(), roles = r.roles || {}, list = roles.roles || [];
        var def = list.filter(function (x) { return x.role_id === roles.default_role; })[0];
        var host = (c.issuer || '').replace(/^https?:\/\//, '');
        $('done-h1').textContent = (c.siteName || 'videosite') + ' is live';
        $('done-admin').innerHTML =
            '<b>Who administers this site?</b><br>' +
            'Setup did not create an account — videosite has no users and no passwords of its own. ' +
            'Whoever holds the <b>root role</b> at <span class="mono">' + esc(host) + '</span> is this site\'s administrator: ' +
            'they sign in here first and land as <b>' + esc((list[0] && list[0].name) || 'Superadmin') + '</b>. Everyone else gets the default role you just published' +
            (def ? ' — <b>' + esc(def.name) + '</b>' : '') + ' — until an administrator changes it in Admin &rarr; Roles.';
        $('signin-url').value = r.signIn || '';
    }

    // ========================================================================
    // RENDER
    // ========================================================================
    function paintPrimary() {
        var n = $('next');
        if (model.busy) { n.disabled = true; return; }

        if (cur === 0) {
            if (model.s1 === 'ok') { n.textContent = 'Continue'; n.disabled = false; }
            else if (model.s1 === 'testing') { n.textContent = 'Testing connections…'; n.disabled = true; }
            else { n.textContent = 'Test & save'; n.disabled = !stepValid(S1); }
        } else if (cur === 1) {
            n.textContent = 'Continue';
            n.disabled = !stepValid(S2);
        } else if (cur === 2) {
            if (model.s3 === 'saved') { n.textContent = 'Continue'; n.disabled = false; }
            else { n.textContent = 'Save & mint client key'; n.disabled = !stepValid(S3); }
        } else if (cur === 3) {
            n.textContent = 'Continue';
            n.disabled = false;
        } else if (cur === 4) {
            // THE GATE. There is no "Continue" here, in any state.
            if (model.s5 === 'verified') { n.textContent = 'Go to sign-in →'; n.disabled = false; }
            else if (model.s5 === 'verifying') { n.textContent = 'Verifying…'; n.disabled = true; }
            else { n.textContent = 'Verify & connect'; n.disabled = false; }
        }
    }

    function render() {
        var done = cur > LAST;

        qsa('.panel').forEach(function (p) { p.classList.remove('on'); });
        root.querySelector('.panel[data-panel="' + (done ? SUCCESS : cur) + '"]').classList.add('on');
        $('nav').style.display = done ? 'none' : 'flex';
        $('banner').classList.remove('on');

        qsa('.step', $('stepper')).forEach(function (s) {
            var i = +s.getAttribute('data-i');
            s.className = 'step';
            if (done || i < cur) s.classList.add('done');
            else if (i === cur) s.classList.add('active');
            if (i === LAST && cur === LAST && (model.s5 === 'failed' || model.s5 === 'preflight')) s.classList.add('blocked');
            s.querySelector('.dot').innerHTML = (done || i < cur) ? CHECKW : String(i + 1);
        });
        if (done) { stopAge(); return; }

        // step 1
        $('s1-form').classList.toggle('hidden', model.s1 === 'testing' || model.s1 === 'ok');
        $('s1-testing').classList.toggle('hidden', model.s1 !== 'testing');
        $('s1-ready').classList.toggle('hidden', model.s1 !== 'ok');

        // step 2
        derive();

        // step 3
        $('s3-form').classList.toggle('hidden', model.s3 === 'saved');
        $('s3-ready').classList.toggle('hidden', model.s3 !== 'saved');
        if (cur === 2 && model.s3 !== 'saved') renderProbe();

        // step 4 — a pure function of (phase, err)
        var c = model.cert;
        $('m-start').classList.toggle('hidden', c.phase !== 'start');
        $('m-pending').classList.toggle('hidden', c.phase !== 'pending');
        $('m-done').classList.toggle('hidden', c.phase !== 'installed');
        $('m-skipped').classList.toggle('hidden', c.phase !== 'skipped');
        var cg = $('cert-grp');
        cg.classList.remove('bad');
        if (c.phase === 'pending' && c.err) {
            cg.classList.add('bad');
            $('cert-err').innerHTML = (CERT_ERR[c.err] || 'The certificate was rejected.') + ' <span class="mono">(' + esc(c.err) + ')</span>';
        }

        // nav: Skip exists on step 4 ONLY, and is withdrawn once a cert is installed.
        $('back').hidden = cur === 0 || model.s1 === 'testing';
        $('skip').hidden = !(cur === 3 && c.phase !== 'installed');

        // step 5
        var m = model.s5;
        var sheet = (m === 'handoff' || m === 'preflight' || m === 'failed');
        $('c-pre').classList.toggle('hidden', !(m === 'handoff' || m === 'preflight'));
        $('c-ladder-wrap').classList.toggle('hidden', !(m === 'verifying' || m === 'failed'));
        $('c-sheet').classList.toggle('hidden', !sheet);
        $('wait-line').classList.toggle('hidden', m !== 'handoff');
        $('c-verified').classList.toggle('hidden', m !== 'verified');
        $('c-escape').classList.toggle('hidden', m === 'verified');
        $('c-lock').classList.toggle('hidden', m !== 'verified');

        if (m === 'verified') {
            $('c-h1').textContent = 'Connected';
            $('c-sub').textContent = 'The SSO recognises this site, verified our signature, and accepted the role catalogue.';
        } else if (m === 'verifying' || m === 'failed') {
            $('c-h1').textContent = m === 'failed' ? 'Couldn\'t connect' : 'Verifying the connection';
            $('c-sub').innerHTML = m === 'failed'
                ? 'Nothing has been changed at the SSO. The red rung below is the diagnosis — fix that one thing and check again.'
                : 'One signed request proves everything at once.';
        } else {
            $('c-h1').textContent = 'Register this app at your SSO';
            $('c-sub').innerHTML = 'Your SSO doesn\'t hand out client IDs on its own. Add <span class="mono">' +
                esc(C().clientId || 'videosite') + '</span> to its client list, then come back — check again when it\'s there.';
        }
        if (cur === LAST) {
            if (m === 'handoff' || m === 'preflight') renderPreflight();
            if (m === 'verifying' || m === 'failed' || m === 'verified') paintLadder();
            if (m === 'handoff') startAge(); else stopAge();
        } else {
            stopAge();
        }

        paintIcons(root);
        paintPrimary();
    }

    // "last checked Ns ago" — a manual check-now beside it. The verify request is
    // the same one the primary runs, so the two can never disagree.
    var ageTimer = null;
    function startAge() {
        if (ageTimer) return;
        ageTimer = setInterval(function () {
            if (!model.lastCheck) { $('wait-age').textContent = 'not checked yet'; return; }
            var s = Math.round((Date.now() - model.lastCheck) / 1000);
            $('wait-age').textContent = 'last checked ' + (s < 60 ? s + 's' : Math.round(s / 60) + 'm') + ' ago';
        }, 1000);
    }
    function stopAge() { if (ageTimer) { clearInterval(ageTimer); ageTimer = null; } }

    // ========================================================================
    // NAVIGATION
    // ========================================================================
    async function advance() {
        if (cur === 0) {
            if (model.s1 !== 'ok') { await submitInfra(); return; }   // saves IN PLACE
            cur = 1; render(); return;
        }
        if (cur === 1) { await submitSite(); return; }                // POSTs, then advances
        if (cur === 2) {
            if (model.s3 !== 'saved') { await submitSso(); return; }  // mints the key, stays put
            cur = 3;
            render();
            await loadMtls();
            return;
        }
        if (cur === 3) {
            model.skippedCert = model.cert.phase !== 'installed';
            cur = 4;
            render();
            await loadConnect();
            return;
        }
        if (cur === 4) {
            if (model.s5 === 'verified') { await doFinish(); return; } // THE HARD GATE
            await doVerify();
        }
    }

    $('next').addEventListener('click', advance);
    $('back').addEventListener('click', function () { if (cur > 0) { cur--; render(); } });
    $('skip').addEventListener('click', async function () {
        model.cert = { phase: 'skipped', err: null, info: null, cn: '' };
        model.skippedCert = true;
        cur = 4;
        render();
        await loadConnect();
    });
    $('gen-csr').addEventListener('click', genCsr);
    $('install-cert').addEventListener('click', installCert);
    $('cert').addEventListener('input', function () {
        if (model.cert.err) { model.cert.err = null; $('cert-grp').classList.remove('bad'); }
    });
    $('copy-signin').addEventListener('click', function () { copyText($('signin-url').value, this); });
    $('go-signin').addEventListener('click', function () {
        window.location.href = (model.finish && model.finish.signIn) || '/auth/login';
    });

    // Delegated clicks — copy buttons and everything rendered into a diagnosis.
    root.addEventListener('click', async function (ev) {
        var b = ev.target.closest('[data-copy]');
        if (b) { copyText(b.getAttribute('data-copy'), b); return; }
        b = ev.target.closest('[data-copy-el]');
        if (b) { copyText($(b.getAttribute('data-copy-el')).value, b); return; }
        b = ev.target.closest('[data-copy-fn]');
        if (b) { copyText(b.getAttribute('data-copy-fn') === 'json' ? copySheetJson() : copySheetText(), b); return; }

        var a = ev.target.closest('[data-act]');
        if (!a) return;
        var act = a.getAttribute('data-act');

        if (act === 'use-issuer') {
            $('ssoIssuer').value = a.getAttribute('data-issuer');
            clearBad($('ssoIssuer'));
            runProbe(val('ssoIssuer'));
            paintPrimary();
        } else if (act === 'retry') {
            await doVerify();
        } else if (act === 'preflight-retry') {
            await loadConnect();
        } else if (act === 'edit-client') {
            cur = 2; model.s3 = 'pristine'; render();
            $('ssoClientId').focus(); $('ssoClientId').select();
        } else if (act === 'edit-issuer') {
            cur = 2; model.s3 = 'pristine'; render();
            $('ssoIssuer').focus(); $('ssoIssuer').select();
        } else if (act === 'edit-hostname') {
            cur = 1; render();
            $('siteHostname').focus(); $('siteHostname').select();
        } else if (act === 'cert') {
            cur = 3; render(); await loadMtls();
        } else if (act === 'cert-reset') {
            await resetCert('start');
        } else if (act === 'cert-start') {
            model.cert = { phase: 'start', err: null, info: null, cn: '' };
            render();
        } else if (act === 'open-sso') {
            var iss = C().issuer;
            if (iss) window.open(iss + '/admin/clients', '_blank', 'noopener');
        } else if (act === 'open-jwks') {
            if (jwksUrl()) window.open(jwksUrl(), '_blank', 'noopener');
        } else if (act === 'diag') {
            copyText(diagnostics(), a);
        }
    });

    // ========================================================================
    // BOOT
    // ========================================================================
    paintIcons(root);
    render();
})();
