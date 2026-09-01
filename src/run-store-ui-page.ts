export const PIPELINE_RUN_STUDIO_STYLE = String.raw`
    :root {
      --ink: #171816;
      --muted: #6f716c;
      --faint: #9a9c96;
      --line: #dedfd9;
      --line-strong: #c8cac2;
      --paper: #fff;
      --ground: #f1f2ed;
      --blue: #275efe;
      --blue-soft: #eaf0ff;
      --green: #1c7c54;
      --green-soft: #e8f5ee;
      --red: #bf3b35;
      --red-soft: #fbefee;
      --amber: #9d6512;
      --amber-soft: #fbf3e3;
      --shadow: 0 1px 1px rgba(22, 24, 21, .025), 0 10px 32px rgba(22, 24, 21, .04);
      --sans: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--ground); color: var(--ink); font-family: var(--sans); }
    body { min-width: 320px; }
    button, input, select, textarea { font: inherit; }
    button { color: inherit; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid #7898ff; outline-offset: 2px; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 228px minmax(0, 1fr); }
    .rail { position: sticky; top: 0; height: 100vh; padding: 24px 16px 18px; background: #1b1d1a; color: #f8f9f4; display: flex; flex-direction: column; }
    .brand { display: flex; gap: 11px; align-items: center; padding: 0 8px 26px; }
    .mark { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid #4e524a; border-radius: 8px; background: #252824; }
    .brand strong { display: block; letter-spacing: -.02em; font-size: 15px; }
    .brand small { color: #969b91; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
    .rail-label { margin: 14px 10px 7px; color: #73786f; font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .nav { display: grid; gap: 3px; }
    .nav button { width: 100%; padding: 10px 11px; border: 0; border-radius: 7px; background: transparent; color: #aeb2aa; display: flex; align-items: center; gap: 10px; cursor: pointer; text-align: left; font-size: 13px; }
    .nav button:hover { color: #fff; background: #242723; }
    .nav button.active { color: #fff; background: #30332f; box-shadow: inset 0 0 0 1px #3d413a; }
    .nav svg { width: 16px; height: 16px; }
    .nav-count { margin-left: auto; min-width: 22px; padding: 2px 6px; border-radius: 10px; background: #3a3e37; color: #cbd0c6; font: 10px var(--mono); text-align: center; }
    .rail-foot { margin-top: auto; padding: 12px 9px 3px; border-top: 1px solid #30332e; }
    .connection { display: flex; gap: 8px; align-items: center; color: #aeb3aa; font-size: 11px; }
    .pulse { width: 7px; height: 7px; border-radius: 50%; background: #63d297; box-shadow: 0 0 0 4px rgba(99,210,151,.1); }
    .database { margin-top: 7px; overflow: hidden; text-overflow: ellipsis; color: #6f746c; font: 10px var(--mono); white-space: nowrap; }
    .workspace { width: 100%; max-width: 1760px; min-width: 0; margin: 0 auto; padding: 28px 32px 52px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
    .eyebrow { margin-bottom: 5px; color: var(--faint); font-size: 10px; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(24px, 3vw, 36px); line-height: 1.06; letter-spacing: -.045em; font-weight: 680; }
    .lede { margin: 8px 0 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .toolbar { display: flex; gap: 8px; align-items: center; }
    .search { width: min(290px, 30vw); padding: 9px 11px 9px 34px; border: 1px solid var(--line); border-radius: 8px; outline: none; background: var(--paper) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%239a9c96' stroke-width='1.5'%3E%3Ccircle cx='7' cy='7' r='4.5'/%3E%3Cpath d='m10.5 10.5 4 4'/%3E%3C/svg%3E") no-repeat 10px center; box-shadow: 0 1px 0 rgba(0,0,0,.02); font-size: 12px; }
    .search:focus { border-color: #9db3ff; box-shadow: 0 0 0 3px var(--blue-soft); }
    .icon-button { width: 36px; height: 36px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); cursor: pointer; display: grid; place-items: center; }
    .icon-button:hover { border-color: var(--line-strong); }
    .icon-button.spinning svg { animation: spin .65s linear infinite; }
    .primary-button { height: 36px; padding: 0 13px; border: 1px solid #174ce2; border-radius: 8px; background: var(--blue); color: #fff; cursor: pointer; box-shadow: 0 1px 1px rgba(18,54,156,.18); font-size: 11px; font-weight: 700; }
    .primary-button:hover { background: #174fe8; }
    .primary-button:disabled { opacity: .55; cursor: wait; }
    .danger-button { height: 36px; padding: 0 12px; border: 1px solid #e4c6c3; border-radius: 8px; background: #fffafa; color: #a53c36; cursor: pointer; font-size: 11px; font-weight: 700; }
    .danger-button:hover { border-color: #d8a9a5; background: var(--red-soft); }
    .danger-button:disabled { opacity: .45; cursor: not-allowed; }
    .danger-button svg { width: 13px; height: 13px; margin-right: 5px; vertical-align: -2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
    .metric { padding: 14px 15px 13px; border: 1px solid var(--line); background: rgba(255,255,255,.78); border-radius: 9px; box-shadow: 0 1px 0 rgba(255,255,255,.8); }
    .metric-label { color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .metric-value { margin-top: 8px; font: 600 24px/1 var(--mono); letter-spacing: -.05em; }
    .metric-note { margin-top: 6px; color: var(--faint); font-size: 10px; }
    .sheet { border: 1px solid var(--line); border-radius: 11px; background: var(--paper); box-shadow: var(--shadow); overflow: hidden; }
    .sheet-head { min-height: 54px; padding: 12px 15px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .sheet-title { font-size: 13px; font-weight: 700; letter-spacing: -.01em; }
    .sheet-subtitle { color: var(--faint); font-size: 10px; }
    .content-grid { display: grid; grid-template-columns: minmax(340px, .78fr) minmax(500px, 1.22fr); gap: 14px; align-items: start; }
    .run-list { max-height: calc(100vh - 263px); overflow: auto; }
    .run-group { position: sticky; top: 0; z-index: 2; padding: 8px 15px; border-bottom: 1px solid #e7e8e2; background: rgba(248,249,245,.96); color: var(--faint); font-size: 9px; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; backdrop-filter: blur(5px); }
    .run-row { width: 100%; padding: 14px 15px; border: 0; border-bottom: 1px solid #ecece7; background: #fff; cursor: pointer; text-align: left; display: grid; gap: 8px; }
    .run-row:last-child { border-bottom: 0; }
    .run-row:hover { background: #fafbf8; }
    .run-row.running:not(.selected) { background: #f9faff; }
    .run-row.selected { background: #f5f7ff; box-shadow: inset 3px 0 var(--blue); }
    .run-primary, .run-secondary, .detail-heading, .step-head { display: flex; align-items: center; gap: 9px; }
    .run-primary strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 13px; white-space: nowrap; }
    .run-time { margin-left: auto; color: var(--faint); font: 10px var(--mono); }
    .run-secondary { color: var(--muted); font-size: 10px; }
    .run-secondary code { min-width: 0; overflow: hidden; text-overflow: ellipsis; font: 10px var(--mono); white-space: nowrap; }
    .run-activity { min-width: 0; padding: 8px 9px; border-radius: 6px; background: var(--blue-soft); color: #3153b8; display: flex; gap: 8px; align-items: center; font-size: 9px; }
    .run-activity strong { white-space: nowrap; }
    .run-activity span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-parentage { margin: 0 0 12px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--faint); font-size: 9px; }
    .run-parentage button { padding: 0; border: 0; background: none; color: #4165cf; cursor: pointer; font: 9px var(--mono); }
    .nested-runs { margin-bottom: 17px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .nested-run { width: 100%; padding: 9px 11px; border: 0; border-bottom: 1px solid #e9eae4; background: #fbfcf9; cursor: pointer; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; text-align: left; }
    .nested-run:last-child { border-bottom: 0; }
    .nested-run:hover { background: #f5f7ff; }
    .nested-run strong { overflow: hidden; text-overflow: ellipsis; font-size: 10px; white-space: nowrap; }
    .nested-run small { color: var(--faint); font: 9px var(--mono); }
    .dot { width: 4px; height: 4px; border-radius: 50%; background: var(--line-strong); }
    .status { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; border-radius: 999px; font-size: 9px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
    .status-mark { width: 9px; height: 9px; display: inline-grid; place-items: center; font: 800 10px/1 var(--sans); letter-spacing: 0; }
    .status.completed { color: var(--green); background: var(--green-soft); }
    .status.failed, .status.cancelled { color: var(--red); background: var(--red-soft); }
    .status.running { color: var(--blue); background: var(--blue-soft); }
    .status.running .status-mark { border: 1.5px solid #b9c9fa; border-top-color: currentColor; border-radius: 50%; animation: spin .8s linear infinite; font-size: 0; }
    .status.skipped, .status.planned { color: var(--amber); background: var(--amber-soft); }
    .detail { min-height: 460px; }
    .detail-body { padding: 18px; }
    .detail-heading { align-items: flex-start; }
    .detail-heading h2 { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; font-size: 19px; letter-spacing: -.03em; white-space: nowrap; }
    .detail-heading .status { margin-top: 2px; }
    .detail-kicker { margin-bottom: 5px; color: var(--faint); font-size: 9px; font-weight: 750; letter-spacing: .09em; text-transform: uppercase; }
    .run-id { margin-top: 6px; color: var(--faint); font: 10px var(--mono); overflow-wrap: anywhere; }
    .detail-meta { margin: 15px 0 18px; display: grid; grid-template-columns: 1.35fr repeat(3, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .detail-meta > div { min-width: 0; padding: 10px 11px; border-right: 1px solid var(--line); }
    .detail-meta > div:last-child { border-right: 0; }
    .detail-meta label { display: block; margin-bottom: 5px; color: var(--faint); font-size: 9px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
    .detail-meta span { display: block; overflow: hidden; text-overflow: ellipsis; font: 11px var(--mono); white-space: nowrap; }
    .section-title { margin: 18px 0 8px; display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 10px; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; }
    .step-list { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
    .step { position: relative; padding: 12px 13px 12px 43px; border-bottom: 1px solid #e9eae4; }
    .step:last-child { border-bottom: 0; }
    .step:not(:last-child)::after { content: ""; position: absolute; top: 31px; bottom: -7px; left: 22px; width: 1px; background: var(--line); }
    .step-status-icon { position: absolute; top: 13px; left: 13px; z-index: 1; width: 19px; height: 19px; border: 1px solid var(--line); border-radius: 5px; background: #f7f8f5; color: var(--faint); display: grid; place-items: center; }
    .step-status-icon svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
    .step-status-icon.completed { border-color: #bddfce; background: var(--green-soft); color: var(--green); }
    .step-status-icon.running { border-color: #cad6fa; background: var(--blue-soft); color: var(--blue); }
    .step-status-icon.running i { width: 10px; height: 10px; border: 2px solid #bdcaf1; border-top-color: currentColor; border-radius: 50%; animation: spin .8s linear infinite; }
    .step-status-icon.skipped { border-color: #ead5ac; background: var(--amber-soft); color: var(--amber); }
    .step-status-icon.cancelled { border-color: #dfcfcd; background: #f7f1f0; color: #8f5d58; }
    .step-status-icon.failed { border-color: #efcbc8; background: var(--red-soft); color: var(--red); font-size: 11px; font-weight: 800; }
    .step-status-icon.planned { font-size: 12px; line-height: 1; }
    .step-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 12px; white-space: nowrap; }
    .step-head code { color: var(--faint); font: 9px var(--mono); }
    .step-duration { margin-left: auto; color: var(--muted); font: 10px var(--mono); }
    .step-description { margin-top: 4px; color: var(--muted); font-size: 10px; line-height: 1.45; }
    .execution { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 5px; }
    .execution-summary { padding: 4px 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--muted); background: #fbfbf8; font: 9px var(--mono); }
    .execution-summary b { color: var(--faint); font: 700 8px var(--sans); letter-spacing: .06em; text-transform: uppercase; }
    .progress { height: 3px; margin-top: 10px; overflow: hidden; border-radius: 2px; background: #e7e9e2; }
    .progress > i { display: block; height: 100%; background: var(--blue); transition: width .3s ease; }
    .progress-copy { margin-top: 5px; color: var(--faint); font-size: 9px; }
    .step .plan-nested { margin-top: 8px; }
    .progress-details { margin-top: 8px; display: grid; gap: 3px; }
    .progress-detail { min-width: 0; display: flex; align-items: baseline; gap: 6px; color: var(--muted); font: 9px/1.4 var(--mono); }
    .progress-detail b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
    .progress-detail span { color: var(--faint); }
    .progress-detail.completed { color: var(--green); }
    .progress-detail.failed { color: var(--red); }
    .progress-detail.running { color: var(--blue); }
    .progress-detail.pending, .progress-detail.skipped { color: var(--amber); }
    .progress-detail-truncated { color: var(--faint); font: 9px/1.4 var(--mono); }
    .error-card { padding: 12px; border: 1px solid #efcbc8; border-radius: 8px; background: #fff8f7; }
    .error-code { color: var(--red); font: 10px var(--mono); }
    .error-message { margin-top: 6px; font-size: 11px; line-height: 1.5; }
    .logs { border: 1px solid var(--line); border-radius: 8px; background: #20221f; color: #dfe3da; overflow: auto; max-height: 220px; }
    .log-line { display: grid; grid-template-columns: 70px 42px minmax(0, 1fr); gap: 8px; padding: 7px 9px; border-bottom: 1px solid #30332e; font: 9px/1.45 var(--mono); }
    .log-line:last-child { border-bottom: 0; }
    .log-time { color: #777d72; }
    .log-level { color: #8fb0ff; text-transform: uppercase; }
    .log-level.error { color: #ff8c84; }
    .log-level.warn { color: #e8bd72; }
    .log-message { overflow-wrap: anywhere; }
    .empty { min-height: 330px; padding: 38px; display: grid; place-items: center; text-align: center; color: var(--muted); }
    .empty-icon { width: 44px; height: 44px; margin: 0 auto 13px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 12px; background: #fafbf8; }
    .empty strong { display: block; color: var(--ink); font-size: 13px; }
    .empty p { max-width: 300px; margin: 7px auto 0; font-size: 11px; line-height: 1.55; }
    .catalog { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; padding: 14px; }
    .catalog-card { min-height: 150px; padding: 15px; border: 1px solid var(--line); border-radius: 9px; background: #fbfcf9; display: flex; flex-direction: column; }
    .catalog-card h3 { margin: 0; font-size: 13px; letter-spacing: -.015em; }
    .catalog-card p { margin: 8px 0 14px; color: var(--muted); font-size: 10px; line-height: 1.55; }
    .catalog-actions { margin-top: auto; display: flex; gap: 7px; }
    .modal-backdrop { position: fixed; inset: 0; z-index: 50; padding: 22px; display: grid; place-items: center; background: rgba(22,24,21,.42); backdrop-filter: blur(3px); }
    .modal { width: min(720px, 100%); max-height: calc(100vh - 44px); overflow: auto; border: 1px solid #cfd1ca; border-radius: 13px; background: var(--paper); box-shadow: 0 24px 80px rgba(16,18,15,.22); }
    .confirm-modal { width: min(460px, 100%); }
    .confirm-body { padding: 18px 20px 20px; }
    .confirm-copy { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
    .confirm-warning { margin: 14px 0 0; padding: 10px 11px; border: 1px solid #efcbc8; border-radius: 8px; background: #fff8f7; color: #87413c; font-size: 10px; line-height: 1.5; }
    .confirm-actions { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }
    .modal-head { position: sticky; top: 0; z-index: 3; padding: 18px 20px 16px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.97); display: flex; justify-content: space-between; gap: 18px; backdrop-filter: blur(8px); }
    .modal-head h2 { margin: 0; font-size: 18px; letter-spacing: -.03em; }
    .modal-head p { margin: 6px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .close-button { width: 30px; height: 30px; flex: 0 0 auto; border: 1px solid var(--line); border-radius: 7px; background: #fafbf8; cursor: pointer; font-size: 16px; }
    .launch-form { padding: 18px 20px 20px; }
    .parameter-fields { margin: 4px 0 18px; display: grid; gap: 18px; }
    .form-section { min-width: 0; }
    .form-section + .form-section { padding-top: 16px; border-top: 1px solid var(--line); }
    .form-section-head { margin-bottom: 10px; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .form-section-head strong { font-size: 11px; letter-spacing: -.01em; }
    .form-section-head span { color: var(--faint); font-size: 9px; }
    .parameter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px; }
    .field { display: grid; gap: 7px; margin-bottom: 15px; }
    .field label { color: var(--muted); font-size: 10px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    .parameter-grid .field { min-width: 0; margin: 0; }
    .field select, .field textarea, .field input:not([type="checkbox"]) { width: 100%; border: 1px solid var(--line-strong); border-radius: 8px; outline: none; background: #fff; }
    .field select, .field input:not([type="checkbox"]) { height: 38px; padding: 0 10px; font-size: 12px; }
    .field select[multiple] { height: 104px; padding: 6px; }
    .field textarea { min-height: 82px; padding: 10px 11px; resize: vertical; font: 11px/1.55 var(--mono); }
    .field select:focus, .field textarea:focus, .field input:focus { border-color: #8ba7ff; box-shadow: 0 0 0 3px var(--blue-soft); }
    .field-hint { color: var(--faint); font-size: 9px; line-height: 1.5; }
    .boolean-field { min-height: 72px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 8px; background: #fbfcf9; display: flex; align-items: flex-start; gap: 9px; cursor: pointer; transition: border-color .15s ease, background .15s ease; }
    .boolean-field:hover { border-color: var(--line-strong); background: #f8f9f5; }
    .boolean-field input { width: 15px; height: 15px; margin: 1px 0 0 auto; accent-color: var(--blue); }
    .boolean-field strong { display: block; font: 650 10px var(--mono); color: var(--ink); }
    .boolean-field small { display: block; margin-top: 5px; color: var(--muted); font-size: 9px; line-height: 1.4; }
    .required-mark { margin-left: 5px; color: var(--red); font-size: 8px; }
    .advanced { margin: 0 0 14px; border-top: 1px solid var(--line); padding-top: 11px; }
    .advanced summary { color: var(--muted); cursor: pointer; font-size: 10px; font-weight: 700; }
    .advanced .field { margin: 11px 0 0; }
    .command-help { max-height: 190px; margin: 10px 0 0; padding: 11px 12px; overflow: auto; border: 1px solid #dedfd9; border-radius: 8px; background: #f6f7f3; color: #555952; white-space: pre-wrap; font: 9px/1.5 var(--mono); }
    .plan-result { min-height: 110px; max-height: 340px; margin: 2px 0 15px; border: 1px solid #ccd6f2; border-radius: 9px; overflow: auto; }
    .plan-placeholder { padding: 28px; color: var(--faint); font-size: 10px; text-align: center; }
    .plan-summary { padding: 10px 12px; border-bottom: 1px solid var(--line); background: #f8f9f5; display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 10px; }
    .plan-steps { display: grid; }
    .plan-step { padding: 10px 12px; border-bottom: 1px solid #e9eae4; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; }
    .plan-step:last-child { border-bottom: 0; }
    .plan-step-title { min-width: 0; display: flex; align-items: center; gap: 7px; }
    .plan-step-title strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 10px; white-space: nowrap; }
    .plan-kind { padding: 2px 5px; border: 1px solid var(--line); border-radius: 999px; color: var(--faint); background: #fff; font-size: 7px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; }
    .plan-kind.pipeline { border-color: #cad6fa; color: #3153b8; background: var(--blue-soft); }
    .plan-step > small { color: var(--faint); font-size: 9px; line-height: 1.4; }
    .plan-nested { grid-column: 1 / -1; padding: 8px 9px; border-radius: 6px; background: #f5f7ff; color: #4660ad; display: flex; align-items: center; flex-wrap: wrap; gap: 5px; font-size: 8px; }
    .plan-nested strong { margin-right: 3px; font: 650 9px var(--mono); }
    .plan-nested code { padding: 2px 4px; border: 1px solid #d8def2; border-radius: 4px; background: #fff; font: 8px var(--mono); }
    .plan-disposition { grid-row: 1 / span 2; grid-column: 2; align-self: center; padding: 3px 6px; border-radius: 999px; color: var(--green); background: var(--green-soft); font-size: 8px; font-weight: 750; letter-spacing: .05em; text-transform: uppercase; }
    .plan-disposition.skipped { color: var(--amber); background: var(--amber-soft); }
    .launch-error { margin-bottom: 15px; padding: 10px 11px; border: 1px solid #efcbc8; border-radius: 8px; background: #fff8f7; color: var(--red); font-size: 10px; line-height: 1.5; white-space: pre-wrap; }
    .modal-actions { position: sticky; bottom: 0; z-index: 2; margin: 0 -20px -20px; padding: 13px 20px 14px; border-top: 1px solid var(--line); background: rgba(255,255,255,.97); display: flex; justify-content: flex-end; gap: 8px; backdrop-filter: blur(8px); }
    .secondary-button { height: 36px; padding: 0 13px; border: 1px solid var(--line); border-radius: 8px; background: #fff; cursor: pointer; font-size: 11px; font-weight: 650; }
    .toast { position: fixed; right: 22px; bottom: 22px; z-index: 60; max-width: min(420px, calc(100vw - 44px)); padding: 11px 13px; border: 1px solid #bdd8c9; border-radius: 9px; background: #f4fff8; color: #176a47; box-shadow: var(--shadow); font-size: 11px; }
    .hidden { display: none !important; }
    @media (max-width: 980px) {
      .shell { grid-template-columns: 74px minmax(0, 1fr); }
      .rail { padding-inline: 10px; }
      .brand { justify-content: center; padding-inline: 0; }
      .brand-copy, .rail-label, .nav span:not(.nav-count), .rail-foot { display: none; }
      .nav button { justify-content: center; padding: 11px 6px; }
      .nav-count { display: none; }
      .content-grid { grid-template-columns: 1fr; }
      .run-list { max-height: 360px; }
    }
    @media (max-width: 680px) {
      .shell { display: block; }
      .rail { position: sticky; z-index: 10; width: 100%; height: 58px; padding: 8px 12px; flex-direction: row; align-items: center; }
      .brand { padding: 0 8px 0 0; }
      .nav { margin-left: auto; display: flex; }
      .nav button { width: 42px; }
      .workspace { padding: 20px 14px 36px; }
      .topbar { display: block; }
      .toolbar { margin-top: 15px; }
      .search { width: 100%; }
      #clearHistoryButton { width: 36px; padding: 0; font-size: 0; }
      #clearHistoryButton svg { margin: 0; }
      .metrics { grid-template-columns: repeat(2, 1fr); }
      .content-grid { display: block; }
      .detail { margin-top: 12px; }
      .detail-meta { grid-template-columns: repeat(2, 1fr); }
      .detail-meta > div:nth-child(2) { border-right: 0; }
      .detail-meta > div:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
      .parameter-grid { grid-template-columns: 1fr; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
    }
  `;

export const PIPELINE_RUN_STUDIO_SCRIPT = String.raw`
    const state = { snapshot: null, detail: null, detailFingerprint: null, commands: [], view: "runs", selectedRunId: null, query: "", loading: false, launching: false, planning: false, clearing: false, cancelling: false, canCancel: false, canClearHistory: false, planVersion: 0 };
    const $ = (selector) => document.querySelector(selector);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[char]);
    const statusMark = (value) => value === 'completed' ? '✓' : value === 'skipped' ? '×' : value === 'cancelled' ? '■' : value === 'failed' ? '!' : value === 'planned' ? '…' : '';
    const status = (value) => '<span class="status ' + esc(value) + '"><i class="status-mark" aria-hidden="true">' + statusMark(value) + '</i>' + esc(value) + '</span>';
    const duration = (ms) => ms == null ? "—" : ms < 1000 ? Math.max(0, Math.round(ms)) + " ms" : ms < 60000 ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s" : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
    const clock = (ms) => {
      if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '';
      return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(ms);
    };
    const dateTime = (ms) => {
      if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '';
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(ms);
    };
    const isoTime = (ms) => {
      if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '';
      return new Date(ms).toISOString();
    };
    const relative = (ms) => { const delta = Math.max(0, Date.now() - ms); if (delta < 60000) return Math.floor(delta / 1000) + "s ago"; if (delta < 3600000) return Math.floor(delta / 60000) + "m ago"; if (delta < 86400000) return Math.floor(delta / 3600000) + "h ago"; return Math.floor(delta / 86400000) + "d ago"; };
    const shortId = (id) => id.length > 24 ? id.slice(0, 12) + "…" + id.slice(-7) : id;
    function selectedCommand() { return state.commands.find((command) => command.id === $('#launchCommand').value); }
    function parameterLabel(parameter) {
      return parameter.key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
    function parameterHint(parameter) {
      const details = [];
      if (parameter.description) details.push(parameter.description);
      if (parameter.environment) details.push('Environment fallback: ' + parameter.environment);
      if (parameter.multiple) details.push(parameter.choices ? 'Choose one or more values.' : 'Enter one value per line.');
      if (parameter.mustExist) details.push('Must be an existing ' + (parameter.pathKind || 'path') + '.');
      return details.join(' ');
    }
    function parameterControl(parameter, index, scope) {
      const id = scope + '-param-' + index;
      const data = ' data-' + scope + '-parameter-index="' + index + '"';
      const hint = parameterHint(parameter);
      const labelText = parameterLabel(parameter);
      if (parameter.type === 'boolean') {
        return '<label class="boolean-field" for="' + id + '"><span><strong>' + esc(labelText) + '</strong><small>' + esc(hint || 'Enable this option.') + '</small></span><input id="' + id + '" type="checkbox"' + data + (parameter.default ? ' checked' : '') + '></label>';
      }
      const required = parameter.required ? ' required' : '';
      const label = '<label for="' + id + '">' + esc(labelText) + (parameter.required ? '<span class="required-mark">required</span>' : '') + '</label>';
      let control;
      if (parameter.choices) {
        const emptyOption = parameter.multiple || parameter.required ? '' : '<option value="">Use default or leave unset</option>';
        const options = parameter.choices.map((choice) => '<option value="' + esc(choice) + '"' + (choice === parameter.default ? ' selected' : '') + '>' + esc(choice) + '</option>').join('');
        control = '<select id="' + id + '"' + data + (parameter.multiple ? ' multiple' : '') + required + '>' + emptyOption + options + '</select>';
      } else if (parameter.multiple) {
        control = '<textarea id="' + id + '"' + data + ' spellcheck="false" placeholder="One value per line"></textarea>';
      } else {
        const inputType = parameter.type === 'number' ? 'number' : 'text';
        const value = parameter.default === undefined ? '' : String(parameter.default);
        const constraints = parameter.type === 'number' ? (parameter.integer ? ' step="1"' : ' step="any"') + (parameter.min === undefined ? '' : ' min="' + esc(parameter.min) + '"') + (parameter.max === undefined ? '' : ' max="' + esc(parameter.max) + '"') : '';
        const placeholder = parameter.type === 'path' ? (parameter.pathKind === 'directory' ? './directory' : './file') : '';
        control = '<input id="' + id + '" type="' + inputType + '"' + data + ' value="' + esc(value) + '" placeholder="' + placeholder + '"' + constraints + required + '>';
      }
      return '<div class="field">' + label + control + (hint ? '<div class="field-hint">' + esc(hint) + '</div>' : '') + '</div>';
    }
    function renderParameters(command, scope, keys) {
      return command.parameters.map((parameter, index) => keys.has(parameter.key) ? parameterControl(parameter, index, scope) : '').join('');
    }
    function bindExclusiveSelections(command, scope) {
      const fields = command.parameters.flatMap((parameter, index) => {
        if (!parameter.exclusive || !parameter.multiple) return [];
        const field = document.querySelector('[data-' + scope + '-parameter-index="' + index + '"]');
        return field ? [field] : [];
      });
      const clear = (field) => {
        if (field.tagName === 'SELECT') Array.from(field.options).forEach((option) => { option.selected = false; });
        else field.value = '';
      };
      fields.forEach((field) => {
        field.addEventListener('change', () => {
          if (field.selectedOptions?.length || field.value) {
            fields.forEach((other) => { if (other !== field) clear(other); });
          }
        });
      });
    }
    function renderCommandForm() {
      const command = selectedCommand();
      $('#launchTitle').textContent = command?.name || 'Run a pipeline';
      $('#launchDescription').textContent = command ? commandDescription(command) : 'Choose a declared pipeline and provide its inputs.';
      if (!command) {
        $('#parameterFields').innerHTML = '';
        $('#previewPlan').classList.add('hidden');
        return;
      }
      const domainKeys = new Set(command.parameters.filter((parameter) => parameter.group !== 'execution').map((parameter) => parameter.key));
      const executionKeys = new Set(command.parameters.filter((parameter) => parameter.group === 'execution').map((parameter) => parameter.key));
      const section = (title, note, keys) => keys.size ? '<section class="form-section"><div class="form-section-head"><strong>' + title + '</strong><span>' + note + '</span></div><div class="parameter-grid">' + renderParameters(command, 'run', keys) + '</div></section>' : '';
      $('#parameterFields').innerHTML = section('Pipeline inputs', domainKeys.size + ' parameter' + (domainKeys.size === 1 ? '' : 's'), domainKeys) + section('Execution controls', 'Built into Tubeless', executionKeys);
      bindExclusiveSelections(command, 'run');
      $('#previewPlan').classList.toggle('hidden', !command.canPlan);
      invalidatePlan();
    }
    function parameterValues(parameter, index, scope) {
      const control = document.querySelector('[data-' + scope + '-parameter-index="' + index + '"]');
      if (!control) return [];
      if (parameter.type === 'boolean') return [control.checked];
      const rawValues = parameter.multiple
        ? control.tagName === 'SELECT'
          ? Array.from(control.selectedOptions).map((option) => option.value)
          : control.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
        : [control.value];
      return parameter.type === 'number'
        ? rawValues.map((value) => value === '' ? value : Number(value))
        : rawValues;
    }
    function parameterLaunchValues(command) {
      const values = {};
      command.parameters.forEach((parameter, index) => {
        const parameterValue = parameterValues(parameter, index, 'run');
        if (parameter.type === 'boolean') {
          const checked = parameterValue[0];
          if (checked !== Boolean(parameter.default)) values[parameter.key] = checked;
          return;
        }
        if (parameter.multiple) {
          values[parameter.key] = parameterValue;
          return;
        }
        if (parameterValue[0] !== '') values[parameter.key] = parameterValue[0];
      });
      return values;
    }
    function currentPlanInput(command) {
      const input = {};
      command.parameters.forEach((parameter, index) => {
        if (parameter.group !== 'execution') return;
        const values = parameterValues(parameter, index, 'run');
        if (parameter.type === 'boolean') {
          if (values[0] === true) input[parameter.key] = true;
          return;
        }
        if (parameter.multiple && values.length) input[parameter.key] = values;
      });
      return input;
    }
    function invalidatePlan() {
      state.planVersion += 1;
      $('#planResult').classList.add('hidden');
      $('#planResult').innerHTML = '';
    }
    function showLaunchError(message) { $('#launchError').textContent = message; $('#launchError').classList.toggle('hidden', !message); }
    function closeLaunch() { if (state.launching || state.planning) return; $('#launchModal').classList.add('hidden'); showLaunchError(''); }
    function openLaunch(commandId) {
      if (commandId) $('#launchCommand').value = commandId;
      $('#launchModal').classList.remove('hidden');
      renderCommandForm();
      $('#parameterFields').querySelector('input, select, textarea')?.focus();
    }
    function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.remove('hidden'); setTimeout(() => toast.classList.add('hidden'), 4200); }
    function showClearHistoryError(message) { $('#clearHistoryError').textContent = message; $('#clearHistoryError').classList.toggle('hidden', !message); }
    function closeClearHistory() { if (state.clearing) return; $('#clearHistoryModal').classList.add('hidden'); showClearHistoryError(''); }
    function openClearHistory() {
      if (!state.canClearHistory) return;
      const runCount = state.snapshot?.runs.length ?? 0;
      const eventCount = state.snapshot?.runs.reduce((total, run) => total + run.eventCount, 0) ?? 0;
      const activeRunCount = state.snapshot?.activeRunCount ?? 0;
      $('#clearHistoryCopy').textContent = 'Remove ' + runCount + ' recorded run' + (runCount === 1 ? '' : 's') + ' and ' + eventCount + ' event' + (eventCount === 1 ? '' : 's') + ' from this SQLite store.' + (activeRunCount ? ' ' + activeRunCount + ' recorded run' + (activeRunCount === 1 ? ' is' : 's are') + ' still marked active; continue only if no external process is writing to this store.' : '');
      $('#clearHistoryModal').classList.remove('hidden');
      $('#confirmClearHistory').focus();
    }
    async function clearHistory() {
      if (state.clearing) return;
      state.clearing = true;
      const button = $('#confirmClearHistory');
      button.disabled = true;
      button.textContent = 'Clearing…';
      showClearHistoryError('');
      try {
        const response = await fetch('/api/history', { method: 'DELETE', headers: { 'x-tubeless-studio-clear-history': '1' } });
        const result = await response.json();
        if (!response.ok || !result.cleared) throw new Error(result.error || 'History could not be cleared.');
        state.selectedRunId = null;
        $('#clearHistoryModal').classList.add('hidden');
        showToast('Cleared ' + result.eventCount + ' recorded event' + (result.eventCount === 1 ? '' : 's'));
        await refresh(true);
      } catch (error) {
        showClearHistoryError(error.message || String(error));
      } finally {
        state.clearing = false;
        button.disabled = false;
        button.textContent = 'Clear history';
      }
    }
    function metrics(snapshot) {
      const terminal = snapshot.completedRunCount + snapshot.failedRunCount;
      const success = terminal ? Math.round(snapshot.completedRunCount / terminal * 100) : 0;
      const pipelineCount = state.commands.length || snapshot.definitions.length;
      return [
        ["Active now", snapshot.activeRunCount, snapshot.activeRunCount ? "Live execution in progress" : "No work in flight"],
        ["Recorded runs", snapshot.runs.length, "Append-only local history"],
        ["Success rate", success + "%", terminal + " terminal runs"],
        ["Pipelines", pipelineCount, state.commands.length ? "Available to configure" : "Observed in run history"],
      ].map(([label, value, note]) => '<article class="metric"><div class="metric-label">' + label + '</div><div class="metric-value">' + value + '</div><div class="metric-note">' + note + '</div></article>').join("");
    }
    function empty(title, copy) {
      return '<div class="empty"><div><div class="empty-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 5.5h12M4 10h12M4 14.5h8"/></svg></div><strong>' + esc(title) + '</strong><p>' + esc(copy) + '</p></div></div>';
    }
    function commandDescription(command) {
      return command.description || 'Run this typed pipeline command.';
    }
    function commandCatalog(commands) {
      return '<section class="sheet"><div class="sheet-head"><div><div class="sheet-title">Available pipelines</div><div class="sheet-subtitle">Declared by the local studio manifest</div></div><span class="sheet-subtitle">' + commands.length + ' shown</span></div><div class="catalog">' + commands.map((command) => '<article class="catalog-card"><h3>' + esc(command.name) + '</h3><p>' + esc(commandDescription(command)) + '</p><div class="catalog-actions"><button class="primary-button" data-command-id="' + esc(command.id) + '">Configure</button></div></article>').join('') + '</div></section>';
    }
    function runRow(run) {
      const activeStep = run.steps.find((step) => step.status === 'running');
      const nestedCount = descendantsOf(run.runId).length;
      const activity = run.status === 'running' ? '<div class="run-activity"><strong>' + esc(activeStep?.name || activeStep?.id || 'Starting') + '</strong><span>' + esc(activeStep?.progress?.message || 'Execution in progress') + '</span></div>' : '';
      return '<button class="run-row ' + esc(run.status) + ' ' + (rootRunId(state.selectedRunId) === run.runId ? 'selected' : '') + '" data-run-id="' + esc(run.runId) + '"><div class="run-primary">' + status(run.status) + '<strong>' + esc(run.pipelineId) + '</strong><time class="run-time" datetime="' + isoTime(run.startedAtMs) + '" title="' + esc(dateTime(run.startedAtMs)) + '">' + relative(run.startedAtMs) + '</time></div><div class="run-secondary"><code>' + esc(shortId(run.runId)) + '</code><i class="dot"></i><span>' + duration(run.durationMs) + '</span><i class="dot"></i><span>' + run.steps.length + ' steps</span>' + (nestedCount ? '<i class="dot"></i><span>' + nestedCount + ' nested run' + (nestedCount === 1 ? '' : 's') + '</span>' : '') + (run.dryRun ? '<i class="dot"></i><span>dry run</span>' : '') + '</div>' + activity + '</button>';
    }
    function stepRow(step) {
      const progressTotal = step.progress?.total;
      const progressWidth = progressTotal ? Math.max(0, Math.min(100, step.progress.completed / progressTotal * 100)) : (step.status === "completed" ? 100 : 18);
      const execution = step.attempt ? '<span class="execution-summary" title="' + esc(step.attempt.attemptId) + '"><b>Execution</b> · ' + esc(shortId(step.attempt.attemptId)) + (step.attempt.retries.length ? ' · ' + step.attempt.retries.length + ' retr' + (step.attempt.retries.length === 1 ? 'y' : 'ies') : '') + '</span>' : '';
      const nested = step.nestedPipeline;
      const remote = step.remote;
      const nestedCount = nested ? (nested.stepCount ?? nested.stepIds.length) : 0;
      const nestedCountLabel = nested && nested.stepIds.length < nestedCount ? nested.stepIds.length + ' of ' + nestedCount + ' declared steps' : nestedCount + ' declared steps';
      const nestedDetail = nested ? '<div class="plan-nested"><strong>' + esc(nested.pipelineId) + '</strong><span>' + nestedCountLabel + (nested.mode === 'for-each' ? ' per runtime item' : '') + '</span>' + nested.stepIds.map((stepId) => '<code>' + esc(stepId) + '</code>').join('') + '</div>' : '';
      const remoteDetail = remote ? '<div class="plan-nested"><strong>' + esc(remote.engine) + '</strong>' + (remote.target ? '<span>' + esc(remote.target) + '</span>' : '') + '</div>' : '';
      const detailCount = step.progress?.detailCount;
      const truncatedDetails = detailCount && step.progress.details && step.progress.details.length < detailCount ? '<div class="progress-detail-truncated">Showing ' + step.progress.details.length + ' of ' + detailCount + ' items</div>' : '';
      const detailRows = step.progress?.details?.length ? '<div class="progress-details">' + step.progress.details.map((detail) => '<div class="progress-detail ' + esc(detail.status || 'running') + '"><b>' + esc(detail.id) + '</b>' + (detail.label ? '<span>' + esc(detail.label) + '</span>' : '') + '</div>').join('') + truncatedDetails + '</div>' : '';
      const progress = step.progress ? '<div class="progress"><i style="width:' + progressWidth + '%"></i></div><div class="progress-copy">' + esc(step.progress.message || (step.progress.completed + (progressTotal ? ' / ' + progressTotal : '') + ' complete')) + '</div>' + detailRows : '';
      return '<article class="step ' + esc(step.status) + '">' + stepStatusIcon(step.status) + '<div class="step-head"><strong>' + esc(step.name || step.id) + '</strong>' + (step.name ? '<code>' + esc(step.id) + '</code>' : '') + '<span class="step-duration">' + duration(step.durationMs) + '</span></div>' + (step.description ? '<div class="step-description">' + esc(step.description) + '</div>' : '') + nestedDetail + remoteDetail + (execution ? '<div class="execution">' + execution + '</div>' : '') + progress + '</article>';
    }
    function stepStatusIcon(value) {
      const label = value.charAt(0).toUpperCase() + value.slice(1);
      const icon = value === 'completed' ? '<svg viewBox="0 0 12 12"><path d="m2 6 2.4 2.4L10 3"/></svg>' : value === 'running' ? '<i></i>' : value === 'skipped' ? '<svg viewBox="0 0 12 12"><path d="m3 3 6 6M9 3 3 9"/></svg>' : value === 'cancelled' ? '<svg viewBox="0 0 12 12"><rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor" stroke="none"/></svg>' : value === 'failed' ? '!' : '…';
      return '<span class="step-status-icon ' + esc(value) + '" role="img" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + icon + '</span>';
    }
    function stepSummary(run) {
      const labels = { running: 'running', failed: 'failed', cancelled: 'cancelled', skipped: 'skipped', completed: 'completed', planned: 'planned' };
      const order = ['running', 'failed', 'cancelled', 'skipped', 'completed', 'planned'];
      return order.map((value) => [value, run.steps.filter((step) => step.status === value).length]).filter(([, count]) => count).map(([value, count]) => count + ' ' + labels[value]).join(' · ') || 'No steps';
    }
    function runDetail(run) {
      if (!run) return '<div class="sheet detail">' + empty('Select a run', 'Choose a run from the history to inspect its steps, retry telemetry, logs, and errors.') + '</div>';
      const ancestors = ancestorsOf(run.runId);
      const parentage = ancestors.length ? '<div class="run-parentage">' + ancestors.map((ancestor) => '<button type="button" data-detail-run-id="' + esc(ancestor.runId) + '">' + esc(ancestor.pipelineId) + '</button><span>/</span>').join('') + '<span>' + esc(run.pipelineId) + '</span></div>' : '';
      const children = childrenOf(run.runId);
      const nested = children.length ? '<div class="section-title"><span>Nested runs</span><span>' + children.length + ' direct · ' + descendantsOf(run.runId).length + ' total</span></div><div class="nested-runs">' + children.map((child) => '<button class="nested-run" type="button" data-detail-run-id="' + esc(child.runId) + '">' + status(child.status) + '<strong>' + esc(child.pipelineId) + '</strong><small>' + duration(child.durationMs) + ' · ' + child.steps.length + ' steps' + (descendantsOf(child.runId).length ? ' · ' + descendantsOf(child.runId).length + ' nested' : '') + '</small></button>').join('') + '</div>' : '';
      const error = run.error ? '<div class="section-title"><span>Error</span></div><div class="error-card"><div class="error-code">' + esc(run.error.code) + ' · ' + esc(run.error.phase) + '</div><div class="error-message">' + esc(run.error.message) + '</div></div>' : '';
      const logs = run.logs.length ? '<div class="section-title"><span>Logs</span><span>' + run.logs.length + '</span></div><div class="logs">' + run.logs.map((log) => '<div class="log-line"><time class="log-time">' + clock(log.timestampMs) + '</time><span class="log-level ' + esc(log.level) + '">' + esc(log.level) + '</span><span class="log-message">' + (log.stepId ? '<b>' + esc(log.stepId) + '</b> · ' : '') + esc(log.message) + '</span></div>').join('') + '</div>' : '';
      return '<article class="sheet detail"><div class="detail-body">' + parentage + '<div class="detail-heading"><div style="min-width:0"><div class="detail-kicker">' + (run.parentRunId ? 'Nested run' : 'Top-level run') + ' · ' + relative(run.startedAtMs) + '</div><h2>' + esc(run.pipelineId) + '</h2><div class="run-id">' + esc(run.runId) + '</div></div><div style="margin-left:auto;display:flex;align-items:center;gap:8px">' + status(run.status) + (state.canCancel && run.status === 'running' && !run.parentRunId && Array.isArray(state.snapshot?.liveRunIds) && state.snapshot.liveRunIds.includes(run.runId) ? '<button class="danger-button" type="button" data-cancel-run-id="' + esc(run.runId) + '"' + (state.cancelling ? ' disabled' : '') + '>Cancel run</button>' : '') + '</div></div><div class="detail-meta"><div><label>Started</label><span title="' + esc(isoTime(run.startedAtMs)) + '">' + esc(dateTime(run.startedAtMs)) + '</span></div><div><label>Duration</label><span>' + duration(run.durationMs) + '</span></div><div><label>Steps</label><span>' + run.steps.length + '</span></div><div><label>Events</label><span>' + run.eventCount + '</span></div></div>' + nested + '<div class="section-title"><span>Step timeline</span><span>' + stepSummary(run) + '</span></div>' + (run.steps.length ? '<div class="step-list">' + run.steps.map(stepRow).join('') + '</div>' : empty('No planned steps', 'This run ended before a step plan was recorded.')) + error + logs + '</div></article>';
    }
    function runById(runId) { return state.snapshot?.runs.find((run) => run.runId === runId); }
    function childrenOf(runId) { return state.snapshot.runs.filter((run) => run.parentRunId === runId).sort((left, right) => right.startedAtMs - left.startedAtMs); }
    function descendantsOf(runId, seen = new Set()) {
      if (seen.has(runId)) return [];
      seen.add(runId);
      return childrenOf(runId).filter((child) => !seen.has(child.runId)).flatMap((child) => [child, ...descendantsOf(child.runId, seen)]);
    }
    function ancestorsOf(runId) {
      const ancestors = [];
      const seen = new Set();
      let current = runById(runId);
      while (current?.parentRunId && !seen.has(current.parentRunId)) {
        seen.add(current.parentRunId);
        const parent = runById(current.parentRunId);
        if (!parent) break;
        ancestors.unshift(parent);
        current = parent;
      }
      return ancestors;
    }
    function rootRunId(runId) { return ancestorsOf(runId).at(0)?.runId || runId; }
    function renderRuns() {
      const query = state.query.toLowerCase();
      const roots = state.snapshot.runs
        .filter((run) => !run.parentRunId || !runById(run.parentRunId))
        .filter((run) => !query || [run, ...descendantsOf(run.runId)].some((candidate) => candidate.pipelineId.toLowerCase().includes(query) || candidate.runId.toLowerCase().includes(query)))
        .sort((left, right) => Number([right, ...descendantsOf(right.runId)].some((run) => run.status === 'running')) - Number([left, ...descendantsOf(left.runId)].some((run) => run.status === 'running')) || right.startedAtMs - left.startedAtMs);
      if (!state.selectedRunId || !roots.some((run) => run.runId === rootRunId(state.selectedRunId))) state.selectedRunId = roots[0]?.runId ?? null;
      const selected = state.detail?.run?.runId === state.selectedRunId ? state.detail.run : null;
      const activeRuns = roots.filter((root) => [root, ...descendantsOf(root.runId)].some((run) => run.status === 'running'));
      const historicalRuns = roots.filter((root) => !activeRuns.includes(root));
      const activeList = activeRuns.length ? '<div class="run-group">Running now · ' + activeRuns.length + '</div>' + activeRuns.map(runRow).join('') : '';
      const historyList = historicalRuns.length ? '<div class="run-group">Recent · ' + historicalRuns.length + '</div>' + historicalRuns.map(runRow).join('') : '';
      $('#content').innerHTML = '<div class="content-grid"><section class="sheet"><div class="sheet-head"><div><div class="sheet-title">Pipeline runs</div><div class="sheet-subtitle">Top-level runs · nested work stays with its parent</div></div><span class="sheet-subtitle">' + roots.length + ' top-level · ' + state.snapshot.runs.length + ' total</span></div><div class="run-list">' + (roots.length ? activeList + historyList : empty('No recorded runs', 'Choose Pipelines to start a run and create local history.')) + '</div></section>' + runDetail(selected) + '</div>';
      document.querySelectorAll('[data-run-id]').forEach((button) => button.addEventListener('click', () => { void selectRun(button.dataset.runId); }));
      document.querySelectorAll('[data-detail-run-id]').forEach((button) => button.addEventListener('click', () => { void selectRun(button.dataset.detailRunId); }));
      document.querySelectorAll('[data-cancel-run-id]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); void cancelRun(button.dataset.cancelRunId); }));
    }
    function renderPipelines() {
      const query = state.query.toLowerCase();
      const commands = state.commands.filter((command) => !query || command.name.toLowerCase().includes(query) || commandDescription(command).toLowerCase().includes(query));
      $('#content').innerHTML = commands.length ? commandCatalog(commands) : '<div class="sheet">' + empty('No pipelines found', 'Try a different pipeline name or description.') + '</div>';
      document.querySelectorAll('[data-command-id]').forEach((button) => button.addEventListener('click', () => openLaunch(button.dataset.commandId)));
    }
    function render() {
      if (!state.snapshot) return;
      const isPipelines = state.view === 'pipelines';
      $('#pageTitle').textContent = isPipelines ? 'Pipelines' : 'Runs';
      $('#pageLede').textContent = isPipelines ? 'Choose a declared workflow to configure and run.' : 'Live work and durable history in one place.';
      $('#search').placeholder = isPipelines ? 'Filter pipelines' : 'Filter runs or IDs';
      $('#metrics').innerHTML = metrics(state.snapshot);
      $('#pipelineCount').textContent = state.commands.length;
      $('#runCount').textContent = state.snapshot.runs.length;
      $('#clearHistoryButton').disabled = state.snapshot.runs.length === 0;
      $('#clearHistoryButton').title = state.snapshot.activeRunCount > 0 ? 'Clear history, including runs left active by an interrupted process' : 'Clear history';
      document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
      isPipelines ? renderPipelines() : renderRuns();
    }
    function selectedRunFingerprint() {
      const run = state.snapshot && state.snapshot.runs.find((item) => item.runId === state.selectedRunId);
      return run ? [run.runId, run.eventCount, run.status].join(':') : null;
    }
    async function loadSelectedRunDetail() {
      if (!state.selectedRunId) {
        state.detail = null;
        state.detailFingerprint = null;
        return;
      }
      const requestedRunId = state.selectedRunId;
      const fingerprint = selectedRunFingerprint();
      if (!fingerprint) {
        state.detail = null;
        state.detailFingerprint = null;
        return;
      }
      if (fingerprint === state.detailFingerprint && state.detail) return;
      const response = await fetch('/api/runs/' + encodeURIComponent(requestedRunId), { cache: 'no-store' });
      if (state.selectedRunId !== requestedRunId) return;
      if (response.status === 404) {
        state.detail = null;
        state.detailFingerprint = null;
        return;
      }
      if (!response.ok) return;
      const detail = await response.json();
      if (state.selectedRunId !== requestedRunId) return;
      state.detail = detail;
      state.detailFingerprint = fingerprint;
    }
    async function selectRun(runId) {
      state.selectedRunId = runId;
      render();
      await loadSelectedRunDetail();
      render();
    }
    async function refresh(manual = false) {
      if (state.loading) return;
      state.loading = true;
      if (manual) $('#refresh').classList.add('spinning');
      try {
        const response = await fetch('/api/snapshot', { cache: 'no-store' });
        if (!response.ok) throw new Error('Snapshot request failed');
        state.snapshot = await response.json();
        render();
        await loadSelectedRunDetail();
        $('#connectionLabel').textContent = 'Connected · local';
        $('.pulse').style.background = '#63d297';
        render();
      } catch (error) {
        $('#connectionLabel').textContent = 'Connection lost';
        $('.pulse').style.background = '#ff8c84';
      } finally {
        state.loading = false;
        $('#refresh').classList.remove('spinning');
      }
    }
    async function loadCommands() {
      try {
        const response = await fetch('/api/commands', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json();
        state.commands = Array.isArray(payload.commands) ? payload.commands : [];
        $('#pipelineNav').classList.toggle('hidden', state.commands.length === 0);
        $('#launchButton').classList.toggle('hidden', state.commands.length === 0);
        $('#launchCommand').innerHTML = state.commands.map((command) => '<option value="' + esc(command.id) + '">' + esc(command.name) + '</option>').join('');
        if (state.commands.length > 0) state.view = 'pipelines';
        renderCommandForm();
        render();
      } catch {}
    }
    async function loadCapabilities() {
      try {
        const response = await fetch('/api/capabilities', { cache: 'no-store' });
        if (!response.ok) return;
        const capabilities = await response.json();
        state.canClearHistory = capabilities.canClearHistory === true;
        state.canCancel = capabilities.canCancel === true;
        $('#clearHistoryButton').classList.toggle('hidden', !state.canClearHistory);
        render();
      } catch {}
    }
    function renderPlan(plan) {
      const selected = plan.steps.filter((step) => step.selected && !step.skipReason).length;
      const errors = plan.errors.length ? '<div class="launch-error">' + plan.errors.map((error) => esc(error.message)).join('<br>') + '</div>' : '';
      const steps = plan.steps.map((step) => {
        const disposition = !step.selected ? 'Not selected' : step.skipReason === 'dry-run' ? 'Dry-run skip' : step.skipReason ? 'Skipped' : 'Will run';
        const detail = step.description || (step.dependencies.length ? 'After ' + step.dependencies.join(', ') : 'No required dependencies');
        const nested = step.nestedPipeline;
        const remote = step.remote;
        const kind = remote ? 'Remote step' : nested ? (nested.mode === 'for-each' ? 'Pipeline fan-out' : 'Nested pipeline') : 'Step';
        const nestedDetail = nested ? '<div class="plan-nested"><strong>' + esc(nested.pipelineId) + '</strong><span>' + nested.stepIds.length + ' declared steps' + (nested.mode === 'for-each' ? ' per runtime item' : '') + '</span>' + nested.stepIds.map((stepId) => '<code>' + esc(stepId) + '</code>').join('') + '</div>' : '';
        const remoteDetail = remote ? '<div class="plan-nested"><strong>' + esc(remote.engine) + '</strong>' + (remote.target ? '<span>' + esc(remote.target) + '</span>' : '') + '</div>' : '';
        return '<div class="plan-step"><div class="plan-step-title"><strong>' + esc(step.name || step.id) + '</strong><span class="plan-kind' + (nested ? ' pipeline' : '') + '">' + kind + '</span></div><small>' + esc(detail) + '</small><span class="plan-disposition' + (disposition === 'Will run' ? '' : ' skipped') + '">' + disposition + '</span>' + nestedDetail + remoteDetail + '</div>';
      }).join('');
      $('#planResult').innerHTML = errors + '<div class="plan-summary"><strong>' + esc(plan.pipelineId) + '</strong><span>' + selected + ' of ' + plan.steps.length + ' steps will run' + (plan.dryRun ? ' · dry run' : '') + '</span></div><div class="plan-steps">' + steps + '</div>';
      $('#planResult').classList.remove('hidden');
    }
    async function previewPlan() {
      const command = selectedCommand();
      if (!command?.canPlan || state.planning) return;
      state.planning = true;
      const planVersion = state.planVersion;
      $('#previewPlan').disabled = true;
      $('#previewPlan').textContent = 'Planning…';
      $('#submitLaunch').disabled = true;
      showLaunchError('');
      try {
        const response = await fetch('/api/commands/' + encodeURIComponent(command.id) + '/plan', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tubeless-studio-plan': '1' },
          body: JSON.stringify(currentPlanInput(command)),
        });
        const result = await response.json();
        if (!response.ok || !result.plan) throw new Error(result.error || 'Plan request failed.');
        if (state.planVersion === planVersion) renderPlan(result.plan);
      } catch (error) {
        showLaunchError(error.message || String(error));
      } finally {
        state.planning = false;
        $('#previewPlan').disabled = false;
        $('#previewPlan').textContent = 'Preview plan';
        $('#submitLaunch').disabled = false;
      }
    }
    async function cancelRun(runId) {
      if (!state.canCancel || !runId || state.cancelling) return;
      state.cancelling = true;
      render();
      try {
        const response = await fetch('/api/runs/' + encodeURIComponent(runId) + '/cancel', {
          method: 'POST',
          headers: { 'x-tubeless-studio-cancel': '1' },
        });
        const result = await response.json();
        if (!response.ok || !result.cancelled) throw new Error(result.error || 'Run could not be cancelled.');
        showToast('Run cancelled · ' + shortId(runId));
        setTimeout(() => refresh(true), 80);
      } catch (error) {
        showToast(error.message || String(error));
      } finally {
        state.cancelling = false;
        render();
      }
    }
    async function launch(event) {
      event.preventDefault();
      const command = selectedCommand();
      if (!command || state.launching) return;
      const values = parameterLaunchValues(command);
      state.launching = true;
      $('#previewPlan').disabled = true;
      $('#submitLaunch').disabled = true;
      $('#submitLaunch').textContent = 'Starting…';
      showLaunchError('');
      try {
        const response = await fetch('/api/commands/' + encodeURIComponent(command.id) + '/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tubeless-studio-launch': '1' },
          body: JSON.stringify({ values }),
        });
        const result = await response.json();
        if (!response.ok || !result.accepted) throw new Error((result.errors || [result.error || 'Launch failed.']).join('\n'));
        state.selectedRunId = result.runId;
        state.view = 'runs';
        $('#launchModal').classList.add('hidden');
        renderCommandForm();
        showToast('Run accepted · ' + shortId(result.runId));
        setTimeout(() => refresh(true), 80);
      } catch (error) {
        showLaunchError(error.message || String(error));
      } finally {
        state.launching = false;
        $('#previewPlan').disabled = false;
        $('#submitLaunch').disabled = false;
        $('#submitLaunch').textContent = 'Run';
      }
    }
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view; render(); }));
    $('#search').addEventListener('input', (event) => { state.query = event.target.value.trim(); render(); });
    $('#refresh').addEventListener('click', () => refresh(true));
    $('#launchButton').addEventListener('click', () => openLaunch());
    $('#clearHistoryButton').addEventListener('click', openClearHistory);
    $('#confirmClearHistory').addEventListener('click', clearHistory);
    $('#closeClearHistory').addEventListener('click', closeClearHistory);
    $('#cancelClearHistory').addEventListener('click', closeClearHistory);
    $('#previewPlan').addEventListener('click', previewPlan);
    $('#closeLaunch').addEventListener('click', closeLaunch);
    $('#cancelLaunch').addEventListener('click', closeLaunch);
    $('#launchCommand').addEventListener('change', renderCommandForm);
    $('#runPane').addEventListener('input', invalidatePlan);
    $('#launchForm').addEventListener('submit', launch);
    $('#launchModal').addEventListener('click', (event) => { if (event.target === $('#launchModal')) closeLaunch(); });
    $('#clearHistoryModal').addEventListener('click', (event) => { if (event.target === $('#clearHistoryModal')) closeClearHistory(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeLaunch(); closeClearHistory(); } });
    loadCommands();
    loadCapabilities();
    refresh();
    setInterval(() => refresh(), 1200);
  `;

export const PIPELINE_RUN_STUDIO_HTML =
  String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>Tubeless — Local Studio</title>
  <style>` +
  PIPELINE_RUN_STUDIO_STYLE +
  String.raw`</style>
</head>
<body>
  <div class="shell">
    <aside class="rail">
      <div class="brand">
        <div class="mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 4.5h6a3 3 0 0 1 3 3v6" stroke="#f7f8f3" stroke-width="1.5"/><circle cx="3" cy="4.5" r="2" fill="#7396ff"/><circle cx="12" cy="13.5" r="2" fill="#63d297"/></svg>
        </div>
        <div class="brand-copy"><strong>Tubeless</strong><small>Local studio</small></div>
      </div>
      <div class="rail-label">Workspace</div>
      <nav class="nav" aria-label="Studio sections">
        <button class="hidden" data-view="pipelines" id="pipelineNav" title="Pipelines">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 5h7M4 10h12M9 15h7"/><circle cx="14.5" cy="5" r="1.5"/><circle cx="5.5" cy="15" r="1.5"/></svg>
          <span>Pipelines</span><b class="nav-count" id="pipelineCount">0</b>
        </button>
        <button class="active" data-view="runs" title="Runs">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 3v4l2.5 1.5M17 10a7 7 0 1 1-2.05-4.95"/><path d="M14.5 2.8v3.5H18"/></svg>
          <span>Runs</span><b class="nav-count" id="runCount">0</b>
        </button>
      </nav>
      <div class="rail-foot">
        <div class="connection"><i class="pulse"></i><span id="connectionLabel">Connected · local</span></div>
        <div class="database">append-only SQLite</div>
      </div>
    </aside>
    <main class="workspace">
      <header class="topbar">
        <div><div class="eyebrow">Execution workspace</div><h1 id="pageTitle">Runs</h1><p class="lede" id="pageLede">Live work and durable history in one place.</p></div>
        <div class="toolbar">
          <input class="search" id="search" type="search" placeholder="Filter runs or IDs" aria-label="Filter" />
          <button class="primary-button hidden" id="launchButton">Run pipeline</button>
          <button class="danger-button hidden" id="clearHistoryButton" type="button" title="Clear history"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 4.5h10M6 2.5h4M5 4.5l.5 9h5l.5-9M7 7v4M9 7v4"/></svg><span>Clear history</span></button>
          <button class="icon-button" id="refresh" title="Refresh now" aria-label="Refresh now"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16.5 7A7 7 0 1 0 17 11"/><path d="M16.5 3v4h-4"/></svg></button>
        </div>
      </header>
      <section class="metrics" id="metrics"></section>
      <section id="content"></section>
    </main>
  </div>
  <div class="modal-backdrop hidden" id="launchModal" role="dialog" aria-modal="true" aria-labelledby="launchTitle">
    <div class="modal">
      <div class="modal-head">
        <div><div class="detail-kicker">Configure pipeline</div><h2 id="launchTitle">Run a pipeline</h2><p id="launchDescription">Choose a declared pipeline and provide its inputs.</p></div>
        <button class="close-button" id="closeLaunch" type="button" aria-label="Close">&times;</button>
      </div>
      <form class="launch-form" id="launchForm">
        <div class="field"><label for="launchCommand">Pipeline command</label><select id="launchCommand"></select></div>
        <div id="runPane"><div class="parameter-fields" id="parameterFields"></div></div>
        <div class="plan-result hidden" id="planResult" aria-live="polite"></div>
        <div class="launch-error hidden" id="launchError"></div>
        <div class="modal-actions"><button class="secondary-button" id="cancelLaunch" type="button">Cancel</button><button class="secondary-button hidden" id="previewPlan" type="button">Preview plan</button><button class="primary-button" id="submitLaunch" type="submit">Run</button></div>
      </form>
    </div>
  </div>
  <div class="modal-backdrop hidden" id="clearHistoryModal" role="dialog" aria-modal="true" aria-labelledby="clearHistoryTitle">
    <div class="modal confirm-modal">
      <div class="modal-head">
        <div><div class="detail-kicker">Local maintenance</div><h2 id="clearHistoryTitle">Clear run history?</h2><p>This permanently resets the local studio history.</p></div>
        <button class="close-button" id="closeClearHistory" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="confirm-body">
        <p class="confirm-copy" id="clearHistoryCopy"></p>
        <div class="confirm-warning">This cannot be undone. Pipeline definitions and execution remain unchanged; only recorded local events are removed.</div>
        <div class="launch-error hidden" id="clearHistoryError"></div>
        <div class="confirm-actions"><button class="secondary-button" id="cancelClearHistory" type="button">Cancel</button><button class="danger-button" id="confirmClearHistory" type="button">Clear history</button></div>
      </div>
    </div>
  </div>
  <div class="toast hidden" id="toast" role="status"></div>
  <script>` +
  PIPELINE_RUN_STUDIO_SCRIPT +
  String.raw`</script>
</body>
</html>`;
