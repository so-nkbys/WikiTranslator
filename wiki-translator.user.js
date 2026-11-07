// ==UserScript==
// @name         Edge Wikipedia 日本語訳併記
// @namespace    local.wiki-translator
// @version      1.0.1
// @author       whale shark
// @description  Edge の「日本語に翻訳」後、英文の各センテンス直後に【日本語訳】を併記します。
// @match        https://en.wikipedia.org/wiki/*
// @match        https://en.m.wikipedia.org/wiki/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const TRANSLATION_CLASS = 'wiki-ja-translation';
    const EXCLUDED = [
        `.${TRANSLATION_CLASS}`, 'script', 'style', 'noscript', 'textarea',
        'button', 'input', 'select', 'code', 'pre', 'math', 'svg',
        '[hidden]', '[aria-hidden="true"]', '[translate="no"]', '.notranslate',
        '.reference', '.mw-ref', '.mw-editsection', '.mwe-math-element',
        '.noprint', '.navbox', '.vertical-navbox', '.metadata', '.reflist',
        '.mw-references-wrap', '.toc', '#toc', '.infobox', '.sidebar'
    ].join(',');

    function isSupportedBrowser(navigator) {
        return /Edg\/\d/.test(navigator.userAgent) && /Windows NT/.test(navigator.userAgent);
    }

    function segmentSentences(text) {
        const parts = typeof Intl.Segmenter === 'function'
            ? Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text),
                part => ({ text: part.segment, index: part.index }))
            : Array.from(text.matchAll(/[\s\S]+?(?:[.!?]+["'”’)\]]*(?=\s|$)|$)/g),
                part => ({ text: part[0], index: part.index }));
        const merged = [];
        for (const part of parts) {
            const previous = merged[merged.length - 1];
            if (previous && /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|No|Fig|Eq|vs)|\b[A-Z]|e\.g|i\.e)\.\s*$/.test(previous.text)) {
                previous.text += part.text;
            } else {
                merged.push({ ...part });
            }
        }
        return merged.map(part => {
            const leading = part.text.length - part.text.trimStart().length;
            const sentence = part.text.trim();
            return { text: sentence, start: part.index + leading, end: part.index + leading + sentence.length };
        }).filter(part => /[a-z]/i.test(part.text));
    }

    function collectTargets(block) {
        const walker = block.ownerDocument.createTreeWalker(block, 4, {
            acceptNode(node) {
                return node.parentElement.closest(EXCLUDED) ? 2 : 1;
            }
        });
        const nodes = [];
        let text = '';
        while (walker.nextNode()) {
            const node = walker.currentNode;
            nodes.push({ node, start: text.length, end: text.length + node.data.length });
            text += node.data;
        }
        const targets = segmentSentences(text).map(sentence => {
            const endpoint = nodes.find(entry => entry.start < sentence.end && entry.end >= sentence.end);
            return { ...sentence, node: endpoint.node, offset: sentence.end - endpoint.start, block };
        });
        return { text, targets };
    }

    function createTranslation(doc, translation) {
        const span = doc.createElement('span');
        span.className = TRANSLATION_CLASS;
        span.lang = 'ja';
        span.setAttribute('translate', 'no');
        span.textContent = `【${translation}】`;
        return span;
    }

    function insertTranslation(target, translation) {
        const { node, offset, block } = target;
        const span = createTranslation(node.ownerDocument, translation);
        if (offset < node.data.length) node.splitText(offset);
        let anchor = node;
        // Keep trailing citations with the English sentence, outside the translation's line breaks.
        while (true) {
            let next = anchor.nextSibling;
            while (next && next.nodeType === 3 && !next.data.trim()) next = next.nextSibling;
            if (next && next.nodeType === 1 && next.matches('.reference, .mw-ref')) {
                anchor = next;
            } else if (!next && anchor.parentNode !== block && anchor.parentNode &&
                anchor.parentNode.nodeType === 1) {
                anchor = anchor.parentNode;
            } else {
                break;
            }
        }
        anchor.after(span);
        return span;
    }

    function prepareBlock(block) {
        const { text, targets } = collectTargets(block);
        if (!targets.length) return null;
        const doc = block.ownerDocument;
        const original = doc.createDocumentFragment();
        const temporary = doc.createElement('span');
        temporary.className = 'wiki-edge-staging';
        temporary.lang = 'en';
        temporary.setAttribute('translate', 'yes');
        const sentences = [];
        const sources = [];
        let offset = 0;
        for (const [index, target] of targets.entries()) {
            const sentence = doc.createElement('span');
            sentence.className = 'wiki-edge-sentence';
            const end = index === targets.length - 1 ? text.length : target.end;
            const source = {
                text: text.slice(offset, end),
                end: target.end - offset
            };
            sentence.textContent = source.text;
            temporary.append(sentence);
            sentences.push(sentence);
            sources.push(source);
            offset = target.end;
        }
        // Move, rather than clone, original nodes to retain markup and attached event listeners.
        while (block.firstChild) original.append(block.firstChild);
        block.append(temporary);
        return {
            block, original, temporary, sentences, targets, sources,
            translations: targets.map(() => null), completed: false
        };
    }

    function readTranslations(snapshot) {
        if (snapshot.completed) return snapshot.targets.map(() => null);
        if (!snapshot.block.isConnected || snapshot.temporary.parentNode !== snapshot.block ||
            snapshot.sentences.some(sentence => !snapshot.temporary.contains(sentence))) {
            throw new Error('翻訳用の本文構造が変更されました。「原文に戻す」か再読み込みしてください。');
        }
        const outside = snapshot.block.ownerDocument.createTreeWalker(snapshot.block, 4);
        while (outside.nextNode()) {
            const node = outside.currentNode;
            if (node.data.trim() && !snapshot.sentences.some(sentence => sentence.contains(node))) {
                throw new Error('訳文の文字がセンテンスの外に移動しています。欠損を防ぐため取り込みを停止しました。' +
                    '「原文に戻す」から再読み込みしてやり直してください。');
            }
        }
        return snapshot.sentences.map((sentence, index) => {
            if (snapshot.translations[index] !== null) return null;
            const translated = sentence.textContent.trim();
            const source = snapshot.targets[index].text;
            return translated !== source && /[\u3040-\u30ff\u3400-\u9fff]/.test(translated)
                ? translated : null;
        });
    }

    function restoreBlock(snapshot) {
        snapshot.block.replaceChildren(snapshot.original);
    }

    function captureTranslations(snapshot, translations) {
        translations.forEach((translation, index) => {
            if (translation === null || snapshot.translations[index] !== null) return;
            const sentence = snapshot.sentences[index];
            const source = snapshot.sources[index];
            const node = sentence.ownerDocument.createTextNode(source.text);
            sentence.replaceChildren(node);
            insertTranslation({ node, offset: source.end, block: sentence }, translation);
            sentence.setAttribute('translate', 'no');
            sentence.classList.add('notranslate');
            snapshot.translations[index] = translation;
        });
    }

    function install(doc, navigator) {
        if (!isSupportedBrowser(navigator)) return;
        const content = doc.querySelector('#mw-content-text .mw-parser-output') ||
            doc.querySelector('#mw-content-text');
        if (!content || doc.getElementById('wiki-ja-controls')) return;

        const style = doc.createElement('style');
        style.textContent = `
            #wiki-ja-controls { position: fixed; right: 16px; bottom: 16px; z-index: 10000;
                display: grid; gap: 8px; width: 250px; max-width: calc(100vw - 32px);
                max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box;
                padding: 12px; border: 1px solid #72777d;
                border-radius: 8px; background: #fff; color: #202122; box-shadow: 0 2px 8px #0003;
                font: 14px/1.5 sans-serif; }
            #wiki-ja-controls button { margin: 0; padding: 5px 10px; cursor: pointer; }
            #wiki-ja-controls > button { justify-self: start; }
            #wiki-ja-controls p { margin: 0; }
            #wiki-ja-controls .wiki-ja-usage { font-weight: bold; cursor: help; }
            #wiki-ja-controls .wiki-ja-import { justify-self: start; }
            #wiki-ja-controls .wiki-ja-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
            #wiki-ja-controls [role="status"] { font-size: 12px; overflow-wrap: anywhere; }
            .wiki-edge-sentence { display: block; }
            .${TRANSLATION_CLASS} { display: block; color: #245b35; white-space: normal; }
            .wiki-ja-heading-translation { font-size: 0.75em; font-weight: normal; }
            .wiki-ja-hidden .${TRANSLATION_CLASS} { display: none; }
            @media (prefers-color-scheme: dark) {
                #wiki-ja-controls { background: #202122; color: #eaecf0; }
                .${TRANSLATION_CLASS} { color: #70c994; }
            }`;
        doc.head.append(style);
        const panel = doc.createElement('aside');
        panel.id = 'wiki-ja-controls';
        panel.className = 'notranslate';
        panel.setAttribute('translate', 'no');
        panel.setAttribute('aria-label', 'Edge Wikipedia 日本語訳併記');
        const notice = doc.createElement('p');
        notice.className = 'wiki-ja-usage';
        notice.textContent = '〇 使い方';
        notice.title = '"元の言語で表示" メニューは使わないでください';
        notice.tabIndex = 0;
        const prepare = doc.createElement('button');
        prepare.textContent = '① 原文を保存';
        const translateInstruction = doc.createElement('p');
        translateInstruction.textContent = '② 右クリック "日本語に翻訳" 実施';
        const importButton = doc.createElement('button');
        importButton.textContent = '③ 英文を差し入れる';
        importButton.title = '必要に応じ都度押下してください。';
        importButton.disabled = true;
        const importRow = doc.createElement('div');
        importRow.className = 'wiki-ja-import';
        importRow.title = importButton.title;
        importRow.append(importButton);
        const reset = doc.createElement('button');
        reset.textContent = '原文に戻す';
        reset.disabled = true;
        const toggle = doc.createElement('button');
        toggle.textContent = '訳文を隠す';
        toggle.disabled = true;
        toggle.setAttribute('aria-pressed', 'false');
        const actions = doc.createElement('div');
        actions.className = 'wiki-ja-actions';
        actions.append(reset, toggle);
        const status = doc.createElement('p');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = '英語の状態で①を押してください。翻訳メニューは手動操作です。';
        panel.append(notice, prepare, translateInstruction, importRow, actions, status);
        doc.body.append(panel);

        let snapshots = [];
        let blockAttributes = [];
        let headingSnapshots = [];
        function report(error) {
            console.error('[WikiTranslator]', error);
            status.textContent = `エラー：${error.message}`;
        }
        function restoreAttributes() {
            for (const { block, translate } of blockAttributes) {
                if (translate === null) block.removeAttribute('translate');
                else block.setAttribute('translate', translate);
            }
            blockAttributes = [];
        }
        function saveHeadings() {
            const headings = new Set([
                ...doc.querySelectorAll('#firstHeading'),
                ...content.querySelectorAll('h1, h2, h3, h4, h5, h6'),
                ...doc.querySelectorAll('#vector-toc .vector-toc-text, .toc .toctext, #toc .toctext')
            ]);
            for (const heading of headings) {
                if (Array.from(headings).some(other => other !== heading && other.contains(heading))) continue;
                const source = collectTargets(heading).text.trim();
                const canTranslate = !heading.matches('.vector-toc-text, .toctext') &&
                    !heading.closest(EXCLUDED) && /[a-z]/i.test(source);
                const original = doc.createDocumentFragment();
                while (heading.firstChild) original.append(heading.firstChild);
                headingSnapshots.push({
                    heading, original, translate: heading.getAttribute('translate'), restored: false,
                    source, canTranslate, translationElement: null
                });
                heading.append(original.cloneNode(true));
                if (!canTranslate) heading.setAttribute('translate', 'no');
            }
        }
        function restoreHeadings(resetAttributes = false) {
            for (const snapshot of headingSnapshots) {
                if (!snapshot.restored) {
                    snapshot.heading.replaceChildren(snapshot.original);
                    snapshot.restored = true;
                }
                if (resetAttributes) {
                    if (snapshot.translationElement) snapshot.translationElement.remove();
                    snapshot.heading.classList.remove('wiki-ja-hidden');
                    if (snapshot.translate === null) snapshot.heading.removeAttribute('translate');
                    else snapshot.heading.setAttribute('translate', snapshot.translate);
                }
            }
            if (resetAttributes) headingSnapshots = [];
        }
        function captureHeadings() {
            const results = headingSnapshots.map(snapshot => {
                if (snapshot.restored) return null;
                if (!snapshot.heading.isConnected) {
                    throw new Error('記事の見出しが更新されました。再読み込みしてやり直してください。');
                }
                if (!snapshot.canTranslate) return null;
                const translation = collectTargets(snapshot.heading).text.trim();
                return translation !== snapshot.source && /[\u3040-\u30ff\u3400-\u9fff]/.test(translation)
                    ? translation : null;
            });
            headingSnapshots.forEach((snapshot, index) => {
                if (snapshot.restored || (snapshot.canTranslate && results[index] === null)) return;
                snapshot.heading.replaceChildren(snapshot.original);
                snapshot.restored = true;
                snapshot.heading.setAttribute('translate', 'no');
                if (results[index] !== null) {
                    const span = createTranslation(doc, results[index]);
                    span.classList.add('wiki-ja-heading-translation');
                    snapshot.heading.append(span);
                    snapshot.translationElement = span;
                }
            });
        }
        prepare.addEventListener('click', () => {
            if (snapshots.length) return;
            try {
                const blocks = Array.from(content.querySelectorAll('p, li, dd, dt, figcaption'))
                    .filter(block => !block.closest(EXCLUDED) &&
                        !block.querySelector('p, li, dd, dt, figcaption'));
                for (const block of blocks) {
                    const snapshot = prepareBlock(block);
                    if (snapshot) snapshots.push(snapshot);
                }
                if (!snapshots.length) {
                    throw new Error('翻訳対象の英文が見つかりません。英語の記事本文で実行してください。');
                }
                saveHeadings();
                prepare.disabled = true;
                importButton.disabled = false;
                reset.disabled = false;
                status.textContent = `${snapshots.reduce((sum, item) => sum + item.targets.length, 0)} 文を保存しました。②を実施してください。`;
            } catch (error) {
                for (const snapshot of snapshots) restoreBlock(snapshot);
                restoreHeadings(true);
                snapshots = [];
                report(error);
            }
        });
        importButton.addEventListener('click', () => {
            if (!snapshots.length) return;
            try {
                const translations = snapshots.map(readTranslations);
                captureHeadings();
                const count = translations.flat().filter(value => value !== null).length;
                snapshots.forEach((snapshot, blockIndex) => {
                    if (snapshot.completed) return;
                    captureTranslations(snapshot, translations[blockIndex]);
                    if (snapshot.translations.every(translation => translation !== null)) {
                        // Restore markup only when no sentence in this block still needs Edge translation.
                        restoreBlock(snapshot);
                        snapshot.completed = true;
                        for (let index = snapshot.targets.length - 1; index >= 0; index--) {
                            insertTranslation(snapshot.targets[index], snapshot.translations[index]);
                        }
                        blockAttributes.push({
                            block: snapshot.block,
                            translate: snapshot.block.getAttribute('translate')
                        });
                        snapshot.block.setAttribute('translate', 'no');
                    }
                });
                const total = snapshots.reduce((sum, snapshot) => sum + snapshot.targets.length, 0);
                const captured = snapshots.reduce((sum, snapshot) =>
                    sum + snapshot.translations.filter(translation => translation !== null).length, 0);
                const pending = total - captured;
                const translatableHeadings = headingSnapshots.filter(snapshot => snapshot.canTranslate);
                const capturedHeadings = translatableHeadings.filter(snapshot => snapshot.translationElement).length;
                const pendingHeadings = translatableHeadings.length - capturedHeadings;
                importButton.disabled = pending === 0 && pendingHeadings === 0;
                toggle.disabled = captured === 0 && capturedHeadings === 0;
                status.textContent = `今回 ${count} 文追加・累計 ${captured}/${total} 文・未取得 ${pending} 文。` +
                    (translatableHeadings.length ? `見出し ${capturedHeadings}/${translatableHeadings.length} 件。` : '') +
                    (pending || pendingHeadings
                        ? (count === 0 ? '新しい日本語訳はありません。' : '')
                        : '英文差し入れ完了。');
            } catch (error) {
                importButton.disabled = true;
                report(error);
            }
        });
        reset.addEventListener('click', () => {
            for (const snapshot of snapshots) {
                if (!snapshot.completed) restoreBlock(snapshot);
            }
            snapshots = [];
            for (const span of content.querySelectorAll(`.${TRANSLATION_CLASS}`)) span.remove();
            restoreAttributes();
            restoreHeadings(true);
            content.classList.remove('wiki-ja-hidden');
            prepare.disabled = true;
            importButton.disabled = true;
            reset.disabled = true;
            toggle.disabled = true;
            toggle.textContent = '訳文を隠す';
            toggle.setAttribute('aria-pressed', 'false');
            status.textContent = '本文・記事タイトル・見出しを原文に戻しました。再読み込みしてからやり直してください。';
        });
        toggle.addEventListener('click', () => {
            const hidden = content.classList.toggle('wiki-ja-hidden');
            for (const snapshot of headingSnapshots) {
                snapshot.heading.classList.toggle('wiki-ja-hidden', hidden);
            }
            toggle.textContent = hidden ? '訳文を表示' : '訳文を隠す';
            toggle.setAttribute('aria-pressed', String(hidden));
        });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            isSupportedBrowser, segmentSentences, collectTargets, insertTranslation,
            prepareBlock, readTranslations, restoreBlock, captureTranslations, install
        };
    } else {
        install(document, navigator);
    }
})();
