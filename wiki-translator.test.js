'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
    isSupportedBrowser, segmentSentences, collectTargets, insertTranslation,
    prepareBlock, readTranslations, restoreBlock, install
} = require('./wiki-translator.user.js');

const edge = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0 Safari/537.36 Edg/142.0' };

function page(html = '<p>Hello, good morning. What did you do yesterday?</p>') {
    return new JSDOM(`<body><div id="mw-content-text"><div class="mw-parser-output">${html}</div></div></body>`).window.document;
}

function buttons(doc) {
    return Array.from(doc.querySelectorAll('#wiki-ja-controls button'));
}

test('limits execution to Windows desktop Edge', () => {
    assert.equal(isSupportedBrowser(edge), true);
    assert.equal(isSupportedBrowser({ userAgent: edge.userAgent.replace('Edg/142.0', '') }), false);
    assert.equal(isSupportedBrowser({ userAgent: edge.userAgent.replace('Windows NT 10.0', 'Macintosh') }), false);
    assert.equal(isSupportedBrowser({ userAgent: 'Android EdgA/142.0' }), false);
    const doc = page();
    install(doc, { userAgent: 'Chrome/142.0' });
    assert.equal(doc.getElementById('wiki-ja-controls'), null);
});

test('segments sentences and preserves exact offsets and whitespace', () => {
    const source = '  Hello, good morning. What did you do yesterday?  ';
    const parts = segmentSentences(source);
    assert.deepEqual(parts.map(part => part.text), ['Hello, good morning.', 'What did you do yesterday?']);
    for (const part of parts) assert.equal(source.slice(part.start, part.end), part.text);
    assert.equal(segmentSentences('Dr. Smith has 3.14 apples. Is that right?').length, 2);
    assert.deepEqual(segmentSentences('123'), []);
});

test('has a punctuation-based fallback when Intl.Segmenter is unavailable', () => {
    const segmenter = Intl.Segmenter;
    try {
        Intl.Segmenter = undefined;
        assert.deepEqual(segmentSentences('Hello. How are you?').map(part => part.text),
            ['Hello.', 'How are you?']);
    } finally {
        Intl.Segmenter = segmenter;
    }
});

test('inserts in reverse order without changing original text or whitespace', () => {
    const doc = page();
    const block = doc.querySelector('p');
    const { targets } = collectTargets(block);
    insertTranslation(targets[1], '昨日は何をしていましたか？');
    insertTranslation(targets[0], 'こんにちは、おはようございます。');
    assert.equal(block.textContent,
        'Hello, good morning.【こんにちは、おはようございます。】 What did you do yesterday?【昨日は何をしていましたか？】');
    for (const span of block.querySelectorAll('.wiki-ja-translation')) span.remove();
    assert.equal(block.textContent, 'Hello, good morning. What did you do yesterday?');
});

test('displays translations on separate lines and removes the line breaks when hidden', () => {
    const doc = page();
    install(doc, edge);
    const [prepare, importButton, reset, toggle] = buttons(doc);
    prepare.click();
    const sentences = doc.querySelectorAll('.wiki-edge-sentence');
    sentences[0].textContent = 'こんにちは、おはようございます。';
    importButton.click();
    const partialTranslation = doc.querySelector('.wiki-ja-translation');
    assert.equal(doc.defaultView.getComputedStyle(partialTranslation).display, 'block');
    sentences[1].textContent = '昨日は何をしていましたか？';
    importButton.click();
    for (const translation of doc.querySelectorAll('.wiki-ja-translation')) {
        assert.equal(doc.defaultView.getComputedStyle(translation).display, 'block');
    }
    toggle.click();
    for (const translation of doc.querySelectorAll('.wiki-ja-translation')) {
        assert.equal(doc.defaultView.getComputedStyle(translation).display, 'none');
    }
    toggle.click();
    assert.equal(doc.defaultView.getComputedStyle(doc.querySelector('.wiki-ja-translation')).display, 'block');
    reset.click();
    assert.equal(doc.querySelector('p').textContent, 'Hello, good morning. What did you do yesterday?');
    assert.equal(doc.querySelector('p br'), null);
    assert.equal(doc.querySelector('.wiki-ja-translation'), null);
});

test('retains original nodes, links, emphasis, references and listeners', () => {
    const doc = page('<p><a href="/wiki/Hello"><b>Hello.</b></a><sup class="reference">[1]</sup> Next sentence.</p>');
    const block = doc.querySelector('p');
    const originalHTML = block.innerHTML;
    const link = block.querySelector('a');
    let clicked = false;
    link.addEventListener('click', event => { event.preventDefault(); clicked = true; });
    const snapshot = prepareBlock(block);
    assert.equal(snapshot.sentences.length, 2);
    assert.equal(block.querySelector('a'), null);
    snapshot.sentences[0].textContent = 'こんにちは。';
    snapshot.sentences[1].textContent = '次の文。';
    assert.deepEqual(readTranslations(snapshot), ['こんにちは。', '次の文。']);
    restoreBlock(snapshot);
    assert.equal(block.innerHTML, originalHTML);
    assert.equal(block.querySelector('a'), link);
    link.click();
    assert.equal(clicked, true);
    insertTranslation(snapshot.targets[1], '次の文。');
    insertTranslation(snapshot.targets[0], 'こんにちは。');
    assert.equal(link.textContent, 'Hello.');
    assert.equal(block.querySelector('.reference').textContent, '[1]');
    assert.equal(block.querySelectorAll('.wiki-ja-translation').length, 2);
});

test('places translations after all trailing citations, keeping them with the preceding sentence', () => {
    const cases = [
        'Hello.<sup class="reference"><a href="#note-1">[1]</a></sup><sup class="reference">[2]</sup> Next sentence.',
        '<a href="#hello"><b>Hello.</b></a><sup class="reference">[1]</sup><sup class="reference">[2]</sup> Next sentence.',
        '<b>Hello.<sup class="reference">[1]</sup></b><sup class="reference">[2]</sup> Next sentence.',
        'Hello. \n<sup class="reference">[1]</sup> <sup class="reference">[2]</sup> Next sentence.',
        '<b>Hello. \n</b><span class="mw-ref">[1]</span><span class="mw-ref">[2]</span> Next sentence.'
    ];
    for (const html of cases) {
        const doc = page(`<p>${html}</p>`);
        const block = doc.querySelector('p');
        const original = block.innerHTML;
        const references = Array.from(block.querySelectorAll('.reference, .mw-ref'));
        const { targets } = collectTargets(block);
        assert.deepEqual(targets.map(target => target.text), ['Hello.', 'Next sentence.']);
        insertTranslation(targets[1], '次の文。');
        const translation = insertTranslation(targets[0], 'こんにちは。');
        assert.equal(references[references.length - 1].nextSibling, translation, html);
        assert.ok(block.textContent.indexOf('[2]') < block.textContent.indexOf('【こんにちは。】'), html);
        assert.equal(block.querySelector('a[href="#note-1"]')?.textContent ?? '[1]', '[1]');
        for (const span of block.querySelectorAll('.wiki-ja-translation')) span.remove();
        assert.equal(block.innerHTML, original, html);
    }
});

test('does not move translations past intervening content or mid-sentence citations', () => {
    const doc = page('<p>Hello.<em> Intervening text</em><sup class="reference">[1]</sup> continues.</p>');
    const block = doc.querySelector('p');
    const { targets } = collectTargets(block);
    const translation = insertTranslation(targets[0], 'こんにちは。');
    assert.equal(translation.nextSibling, block.querySelector('em'));
    assert.equal(block.textContent, 'Hello.【こんにちは。】 Intervening text[1] continues.');
});

test('reads nested translated markup as text and never executes translated HTML', () => {
    const doc = page('<p>Hello.</p>');
    const snapshot = prepareBlock(doc.querySelector('p'));
    snapshot.sentences[0].innerHTML = '<b>こんにちは。</b>&lt;img src=x onerror=alert(1)&gt;';
    const result = readTranslations(snapshot)[0];
    restoreBlock(snapshot);
    insertTranslation(snapshot.targets[0], result);
    assert.equal(doc.querySelector('.wiki-ja-translation img'), null);
    assert.equal(doc.querySelector('.wiki-ja-translation').textContent,
        '【こんにちは。<img src=x onerror=alert(1)>】');
});

test('reports untranslated text and rejects replaced staging elements', () => {
    const doc = page();
    const snapshot = prepareBlock(doc.querySelector('p'));
    assert.deepEqual(readTranslations(snapshot), [null, null]);
    snapshot.sentences[0].remove();
    assert.throws(() => readTranslations(snapshot), /本文構造/);
    restoreBlock(snapshot);
    assert.equal(doc.querySelector('p').textContent, 'Hello, good morning. What did you do yesterday?');
});

test('isolates each translation sentence and includes boundary whitespace inside its capture element', () => {
    const doc = page('<p>  Hello. \nNext sentence.  </p>');
    install(doc, edge);
    const block = doc.querySelector('p');
    const original = block.innerHTML;
    const snapshot = prepareBlock(block);
    assert.deepEqual(snapshot.sentences.map(sentence => sentence.textContent),
        ['  Hello.', ' \nNext sentence.  ']);
    assert.equal(snapshot.temporary.textContent, '  Hello. \nNext sentence.  ');
    assert.deepEqual(Array.from(snapshot.temporary.childNodes), snapshot.sentences);
    for (const sentence of snapshot.sentences) {
        assert.equal(doc.defaultView.getComputedStyle(sentence).display, 'block');
    }
    restoreBlock(snapshot);
    assert.equal(block.innerHTML, original);
});

test('captures the complete Zaku translation across nested text nodes without dropping its first character', () => {
    const doc = page('<p>The Zaku later became better known as a common military machine. While in previous manga and anime giant robots tended to be the tools of protagonists or villains.</p>');
    install(doc, edge);
    const [prepare, importButton, reset] = buttons(doc);
    prepare.click();
    const sentences = doc.querySelectorAll('.wiki-edge-sentence');
    const expected = 'ザクは後に一般的な軍事機械としてよりよく知られるようになりました。';
    sentences[0].replaceChildren(doc.createTextNode('ザ'), doc.createElement('span'));
    sentences[0].lastChild.textContent = expected.slice(1);
    importButton.click();
    assert.equal(doc.querySelector('.wiki-ja-translation').textContent, `【${expected}】`);
    importButton.click();
    assert.equal(doc.querySelectorAll('.wiki-ja-translation').length, 1);
    sentences[1].textContent = '以前の漫画やアニメでは巨大ロボットは主人公や悪役の道具でした。';
    importButton.click();
    assert.equal(doc.querySelector('.wiki-ja-translation').textContent, `【${expected}】`);
    reset.click();
    assert.match(doc.querySelector('p').textContent, /^The Zaku later/);
});

test('rejects translation text outside sentence elements rather than accepting a truncated result', () => {
    const doc = page();
    install(doc, edge);
    const [prepare, importButton, reset] = buttons(doc);
    prepare.click();
    const sentence = doc.querySelector('.wiki-edge-sentence');
    sentence.before(doc.createTextNode('ザ'));
    sentence.textContent = 'クは後に一般的な軍事機械としてよりよく知られるようになりました。';
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    try {
        importButton.click();
        assert.equal(errors.length, 1);
        assert.match(doc.querySelector('[role="status"]').textContent, /欠損を防ぐため取り込みを停止/);
        assert.equal(doc.querySelector('.wiki-ja-translation'), null);
        assert.equal(importButton.disabled, true);
        assert.equal(reset.disabled, false);
        reset.click();
        assert.equal(doc.querySelector('p').textContent, 'Hello, good morning. What did you do yesterday?');
    } finally {
        console.error = originalError;
    }
});

test('also rejects translated characters moved outside the staging container', () => {
    const doc = page();
    const snapshot = prepareBlock(doc.querySelector('p'));
    snapshot.temporary.before(doc.createTextNode('ザ'));
    snapshot.sentences[0].textContent = 'クは後に一般的な軍事機械としてよりよく知られるようになりました。';
    assert.throws(() => readTranslations(snapshot), /文字がセンテンスの外に移動/);
    restoreBlock(snapshot);
    assert.equal(doc.querySelector('p').textContent, 'Hello, good morning. What did you do yesterday?');
});

test('manual workflow imports exactly once, toggles and resets', () => {
    const doc = page();
    install(doc, edge);
    install(doc, edge);
    assert.equal(doc.querySelectorAll('#wiki-ja-controls').length, 1);
    const [prepare, importButton, reset, toggle] = buttons(doc);
    assert.equal(importButton.textContent, '③ 英文を差し入れる');
    assert.match(doc.getElementById('wiki-ja-controls').textContent, /③ 英文を差し入れる/);
    assert.doesNotMatch(doc.getElementById('wiki-ja-controls').textContent, /訳文を取り込む/);
    assert.equal(importButton.disabled, true);
    prepare.click();
    assert.equal(prepare.disabled, true);
    assert.equal(importButton.disabled, false);
    const sentences = doc.querySelectorAll('.wiki-edge-sentence');
    sentences[0].textContent = 'こんにちは、おはようございます。';
    sentences[1].textContent = '昨日は何をしていましたか？';
    importButton.click();
    importButton.click();
    assert.equal(doc.querySelectorAll('.wiki-ja-translation').length, 2);
    assert.equal(doc.querySelector('p').getAttribute('translate'), 'no');
    toggle.click();
    assert.equal(doc.querySelector('.mw-parser-output').classList.contains('wiki-ja-hidden'), true);
    toggle.click();
    assert.equal(doc.querySelector('.mw-parser-output').classList.contains('wiki-ja-hidden'), false);
    reset.click();
    assert.equal(doc.querySelectorAll('.wiki-ja-translation').length, 0);
    assert.equal(doc.querySelector('p').textContent, 'Hello, good morning. What did you do yesterday?');
    assert.equal(doc.querySelector('p').hasAttribute('translate'), false);
    assert.equal(prepare.disabled, true);
    assert.match(doc.querySelector('[role="status"]').textContent, /再読み込み/);
});

test('lays out vertical instructions with hover help and a separated bottom action row', () => {
    const doc = page();
    install(doc, edge);
    const panel = doc.getElementById('wiki-ja-controls');
    const [usage, prepare, instruction, importRow, actions, status] = panel.children;
    assert.equal(usage.textContent, '〇 使い方');
    assert.equal(usage.title, '"元の言語で表示" メニューは使わないでください');
    assert.equal(usage.tabIndex, 0);
    assert.equal(prepare.textContent, '① 原文を保存');
    assert.equal(instruction.textContent, '② 右クリック "日本語に翻訳" 実施');
    assert.equal(instruction.tagName, 'P');
    assert.equal(importRow.querySelector('button').textContent, '③ 英文を差し入れる');
    assert.equal(importRow.title, '必要に応じ都度押下してください。');
    assert.equal(importRow.querySelector('button').title, importRow.title);
    assert.deepEqual(Array.from(actions.children, button => button.textContent), ['原文に戻す', '訳文を隠す']);
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(doc.defaultView.getComputedStyle(panel).display, 'grid');
    assert.equal(doc.defaultView.getComputedStyle(panel).width, '250px');
    assert.equal(doc.defaultView.getComputedStyle(actions).display, 'flex');
    assert.equal(doc.defaultView.getComputedStyle(actions).marginTop, '16px');
    assert.doesNotMatch(panel.textContent, /元の言語で表示/);
    prepare.click();
    doc.querySelector('.wiki-edge-sentence').textContent = 'こんにちは。';
    importRow.querySelector('button').click();
    assert.match(status.textContent, /累計 1\/2 文・未取得 1 文/);
    assert.doesNotMatch(status.textContent, /元の言語で表示|スクロール/);
});

test('preparation can be cancelled without changing original markup', () => {
    const doc = page('<p>Hello <b>there.</b> Next.</p>');
    const original = doc.querySelector('p').innerHTML;
    install(doc, edge);
    const [prepare, , reset] = buttons(doc);
    prepare.click();
    reset.click();
    assert.equal(doc.querySelector('p').innerHTML, original);
});

test('does not duplicate nested blocks or translate excluded areas', () => {
    const doc = page('<ul><li><p>Hello.</p><ul><li>Next.</li></ul></li></ul>' +
        '<div class="reflist"><p>Reference.</p></div><table class="infobox"><tr><td><p>Info.</p></td></tr></table>' +
        '<p translate="no">Not translated.</p>');
    install(doc, edge);
    buttons(doc)[0].click();
    assert.equal(doc.querySelectorAll('.wiki-edge-sentence').length, 2);
    assert.equal(doc.querySelector('.reflist p').textContent, 'Reference.');
    assert.equal(doc.querySelector('.infobox p').textContent, 'Info.');
});

test('unavailable translation waits without finalizing untranslated sentences', () => {
    const doc = page();
    install(doc, edge);
    const [prepare, importButton] = buttons(doc);
    prepare.click();
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    try {
        importButton.click();
        assert.equal(errors.length, 0);
        assert.match(doc.querySelector('[role="status"]').textContent, /累計 0\/2 文・未取得 2 文/);
        assert.match(doc.querySelector('[role="status"]').textContent, /新しい日本語訳はありません/);
        assert.equal(importButton.disabled, false);
        assert.equal(doc.querySelectorAll('.wiki-ja-translation').length, 0);
        doc.querySelector('.wiki-edge-sentence').textContent = 'こんにちは、おはようございます。';
        importButton.click();
        assert.equal(doc.querySelectorAll('.wiki-ja-translation').length, 1);
        assert.match(doc.querySelector('[role="status"]').textContent, /累計 1\/2 文・未取得 1 文/);
        assert.equal(importButton.disabled, false);
    } finally {
        console.error = originalError;
    }
});

test('captures out of order within one text node and keeps pending sentences translatable', () => {
    const doc = page('<p>First sentence. Second sentence. Third sentence.</p>');
    install(doc, edge);
    const [prepare, importButton, reset] = buttons(doc);
    prepare.click();
    const block = doc.querySelector('p');
    const sentences = Array.from(doc.querySelectorAll('.wiki-edge-sentence'));
    sentences[1].textContent = '二番目の文。';
    importButton.click();
    assert.equal(block.textContent, 'First sentence. Second sentence.【二番目の文。】 Third sentence.');
    assert.equal(sentences[1].getAttribute('translate'), 'no');
    assert.equal(sentences[1].classList.contains('notranslate'), true);
    assert.equal(block.hasAttribute('translate'), false);
    assert.equal(sentences[0].closest('[translate="no"], .notranslate'), null);
    assert.equal(sentences[2].closest('[translate="no"], .notranslate'), null);
    importButton.click();
    assert.equal(doc.querySelectorAll('.wiki-ja-translation').length, 1);
    assert.match(doc.querySelector('[role="status"]').textContent, /今回 0 文追加・累計 1\/3 文・未取得 2 文/);
    sentences[0].textContent = '最初の文。';
    importButton.click();
    assert.equal(doc.querySelectorAll('.wiki-ja-translation').length, 2);
    assert.equal(importButton.disabled, false);
    sentences[2].textContent = '三番目の文。';
    importButton.click();
    assert.equal(block.textContent, 'First sentence.【最初の文。】 Second sentence.【二番目の文。】 Third sentence.【三番目の文。】');
    assert.equal(block.querySelector('.wiki-edge-staging'), null);
    assert.equal(block.getAttribute('translate'), 'no');
    assert.equal(importButton.disabled, true);
    assert.match(doc.querySelector('[role="status"]').textContent, /累計 3\/3 文・未取得 0 文/);
    reset.click();
    assert.equal(block.textContent, 'First sentence. Second sentence. Third sentence.');
});

test('preserves links and listeners after incremental paragraph completion', () => {
    const doc = page('<p><a href="#hello"><b>Hello.</b></a><sup class="reference">[1]</sup> Next sentence.</p>');
    const block = doc.querySelector('p');
    const original = block.innerHTML;
    const link = block.querySelector('a');
    let clicks = 0;
    link.addEventListener('click', event => { event.preventDefault(); clicks++; });
    install(doc, edge);
    const [prepare, importButton, reset] = buttons(doc);
    prepare.click();
    const sentences = doc.querySelectorAll('.wiki-edge-sentence');
    sentences[0].textContent = 'こんにちは。';
    importButton.click();
    assert.equal(block.querySelector('a'), null);
    sentences[1].textContent = '次の文。';
    importButton.click();
    assert.equal(block.querySelector('a'), link);
    assert.equal(link.textContent, 'Hello.');
    assert.equal(block.querySelector('.reference').textContent, '[1]');
    assert.equal(block.querySelector('.reference').nextSibling, block.querySelector('.wiki-ja-translation'));
    link.click();
    assert.equal(clicks, 1);
    reset.click();
    assert.equal(block.innerHTML, original);
});

test('does not lose pending paragraphs when another paragraph completes', () => {
    const doc = page('<p>Hello.</p><p>Next sentence.</p><p>Last sentence.</p>');
    install(doc, edge);
    const [prepare, importButton, reset, toggle] = buttons(doc);
    prepare.click();
    const sentences = doc.querySelectorAll('.wiki-edge-sentence');
    sentences[0].textContent = 'こんにちは。';
    importButton.click();
    assert.equal(doc.querySelectorAll('.wiki-edge-staging').length, 2);
    assert.equal(importButton.disabled, false);
    toggle.click();
    sentences[2].textContent = '最後の文。';
    importButton.click();
    assert.equal(doc.querySelectorAll('.wiki-ja-translation').length, 2);
    assert.equal(doc.querySelectorAll('.wiki-edge-staging').length, 1);
    assert.equal(doc.querySelector('.mw-parser-output').classList.contains('wiki-ja-hidden'), true);
    importButton.click();
    assert.equal(doc.querySelectorAll('.wiki-ja-translation').length, 2);
    assert.match(doc.querySelector('[role="status"]').textContent, /累計 2\/3 文・未取得 1 文/);
    reset.click();
    assert.deepEqual(Array.from(doc.querySelectorAll('.mw-parser-output p'), block => block.textContent),
        ['Hello.', 'Next sentence.', 'Last sentence.']);
    assert.equal(doc.querySelectorAll('[translate="no"]').length, 1);
});

test('restores exact markup after partially capturing a paragraph', () => {
    const doc = page('<p>Hello <b>there.</b> Next <a href="#next">sentence.</a></p>');
    const block = doc.querySelector('p');
    const original = block.innerHTML;
    const link = block.querySelector('a');
    install(doc, edge);
    const [prepare, importButton, reset] = buttons(doc);
    prepare.click();
    doc.querySelector('.wiki-edge-sentence').textContent = 'こんにちは。';
    importButton.click();
    reset.click();
    assert.equal(block.innerHTML, original);
    assert.equal(block.querySelector('a'), link);
    assert.equal(doc.querySelector('.wiki-edge-staging'), null);
    assert.equal(doc.querySelector('.wiki-ja-translation'), null);
});

test('keeps English-only proper names pending instead of dropping them', () => {
    const doc = page('<p>Hello. DNA.</p>');
    install(doc, edge);
    const [prepare, importButton] = buttons(doc);
    prepare.click();
    doc.querySelector('.wiki-edge-sentence').textContent = 'こんにちは。';
    importButton.click();
    importButton.click();
    assert.equal(doc.querySelectorAll('.wiki-ja-translation').length, 1);
    assert.equal(importButton.disabled, false);
    assert.equal(doc.querySelectorAll('.wiki-edge-sentence')[1].textContent, ' DNA.');
    assert.match(doc.querySelector('[role="status"]').textContent, /未取得 1 文/);
});

test('structural corruption during incremental capture is reported and reset remains available', () => {
    const doc = page();
    const original = doc.querySelector('p').innerHTML;
    install(doc, edge);
    const [prepare, importButton, reset] = buttons(doc);
    prepare.click();
    const sentences = doc.querySelectorAll('.wiki-edge-sentence');
    sentences[0].textContent = 'こんにちは。';
    importButton.click();
    sentences[1].remove();
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    try {
        importButton.click();
        assert.equal(errors.length, 1);
        assert.match(doc.querySelector('[role="status"]').textContent, /エラー.*本文構造/);
        assert.equal(importButton.disabled, true);
        assert.equal(reset.disabled, false);
        reset.click();
        assert.equal(doc.querySelector('p').innerHTML, original);
    } finally {
        console.error = originalError;
    }
});

test('userscript requests no permissions or direct network translation', () => {
    const fs = require('node:fs');
    const source = fs.readFileSync(require.resolve('./wiki-translator.user.js'), 'utf8');
    assert.match(source, /@grant\s+none/);
    assert.doesNotMatch(source, /GM_xmlhttpRequest|translate\.googleapis\.com|@connect|\bfetch\s*\(/);
});
