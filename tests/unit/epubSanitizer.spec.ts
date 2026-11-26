import { describe, expect, it } from 'vitest'
import {
  CONTENT_CSP,
  sanitizeSectionDocument,
  sanitizeSerializedSection,
  validateEpubArchiveBounds
} from '@/engines/epub/epubEngine'
import {
  createCleanEpubBuffer,
  createZipBombArchiveBuffer
} from '../fixtures/bookFixtures'

describe('EPUB sanitizer, Zip Bomb guard, and <base>/CSP compatibility (US3 - TDD)', () => {
  it('accepts clean EPUB archives and rejects zip bomb archives before ePub parsing', async () => {
    const clean = await createCleanEpubBuffer()
    await expect(validateEpubArchiveBounds(clean)).resolves.toBeUndefined()

    const tooManyEntries = await createZipBombArchiveBuffer('too-many-entries')
    await expect(validateEpubArchiveBounds(tooManyEntries)).rejects.toThrow(/엔트리|Zip|아카이브/)

    const oversized = await createZipBombArchiveBuffer('oversized-uncompressed')
    await expect(validateEpubArchiveBounds(oversized)).rejects.toThrow(/크기|용량|아카이브/)
  })

  it('strips active elements, SVG script/foreignObject/use/animate, dangerous CSS @import/url, and prepends hardened CSP meta', () => {
    const html = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink">
  <head>
    <base href="https://evil.example.com/" />
    <meta http-equiv="refresh" content="0;url=https://evil.example.com/" />
    <style>
      @import url("https://evil.example.com/leak.css");
      .bad { width: expression(alert(1)); background: url("javascript:alert(2)"); }
      .good { color: #111827; }
    </style>
    <script>alert(1)</script>
  </head>
  <body onload="evil()">
    <p id="safe" onclick="evil()">정상 본문</p>
    <a id="badlink" href="javascript:alert(1)">위험 링크</a>
    <img id="badimg" src="data:image/svg+xml;utf8,%3Csvg%3E" />
    <svg viewBox="0 0 10 10">
      <script>evilSvg()</script>
      <foreignObject><div>evil</div></foreignObject>
      <use xlink:href="https://evil.example.com/x.svg#id"></use>
      <animate attributeName="href" values="javascript:alert(3)"></animate>
      <set attributeName="onbegin" to="evil()"></set>
      <circle cx="5" cy="5" r="4"></circle>
    </svg>
  </body>
</html>`

    const doc = new DOMParser().parseFromString(html, 'text/html')
    sanitizeSectionDocument(doc)

    expect(doc.querySelectorAll('script, iframe, base, foreignObject, use, animate, set')).toHaveLength(0)
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull()
    expect(doc.body.getAttribute('onload')).toBeNull()
    expect(doc.getElementById('safe')?.getAttribute('onclick')).toBeNull()
    expect(doc.getElementById('badlink')?.getAttribute('href')).toBeNull()
    expect(doc.getElementById('badimg')?.getAttribute('src')).toBeNull()
    expect(doc.querySelector('svg circle')).not.toBeNull()

    const styleText = doc.querySelector('style')?.textContent || ''
    expect(styleText).not.toMatch(/@import/i)
    expect(styleText).not.toMatch(/expression\(/i)
    expect(styleText).not.toMatch(/javascript:/i)
    expect(styleText).toContain('.good { color: #111827; }')

    const firstHeadMeta = doc.head.firstElementChild
    expect(firstHeadMeta?.tagName.toLowerCase()).toBe('meta')
    expect(firstHeadMeta?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(firstHeadMeta?.getAttribute('content')).toBe(CONTENT_CSP)
    expect(CONTENT_CSP).toContain("default-src 'none'")
    expect(CONTENT_CSP).toContain("base-uri 'none'")
    expect(CONTENT_CSP).toContain("connect-src 'none'")
  })

  /** What the iframe gets: XHTML parsed as XML, first pass, XMLSerializer, second pass. */
  function renderLikeEpubJs(xhtml: string): Document {
    const doc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml')
    sanitizeSectionDocument(doc)
    const serialized = new XMLSerializer().serializeToString(doc)
    const srcdoc = sanitizeSerializedSection(serialized)
    // The iframe parses srcdoc with the HTML parser.
    return new DOMParser().parseFromString(srcdoc, 'text/html')
  }

  function expectNoActiveContent(doc: Document) {
    for (const el of Array.from(doc.getElementsByTagName('*'))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith('on'), `${el.tagName} ${attr.name}`).toBe(false)
      }
    }
    expect(doc.querySelectorAll('script, iframe, object, embed, noscript')).toHaveLength(0)
    const first = doc.head.firstElementChild
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(first?.getAttribute('content')).toBe(CONTENT_CSP)
  }

  const XHTML_HEAD = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head>'

  it('blocks processing-instruction smuggling that becomes live markup after the HTML reparse', () => {
    const doc = renderLikeEpubJs(
      `<?xml version="1.0" encoding="utf-8"?>\n<?foo > <img src="x" onerror="parent.pwned=1"> ?>\n${XHTML_HEAD}<body><p>본문</p><?bar > <svg onload="parent.pwned=2"></svg> ?></body></html>`
    )
    expectNoActiveContent(doc)
    expect(doc.body.textContent).toContain('본문')
  })

  it('blocks doctype system-identifier smuggling', () => {
    const doc = renderLikeEpubJs(
      `<?xml version="1.0"?>\n<!DOCTYPE html SYSTEM "x><img src=x onerror=parent.pwned=1>">\n${XHTML_HEAD}<body><p>본문</p></body></html>`
    )
    expectNoActiveContent(doc)
  })

  it('removes noscript, comments and CDATA-based payloads but keeps book content', () => {
    const doc = renderLikeEpubJs(
      `${XHTML_HEAD}<body><noscript><p title="&lt;/noscript&gt;&lt;img src=x onerror=parent.pwned=1&gt;">x</p></noscript><!-- --><p id="keep">유지 <a href="ch2.xhtml#s1">다음</a></p><svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[</style><img src=x onerror=parent.pwned=3>]]></style><circle r="1"/></svg><img id="pic" src="images/a.png" alt="그림"/></body></html>`
    )
    expectNoActiveContent(doc)
    expect(doc.getElementById('keep')?.textContent).toContain('유지')
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('ch2.xhtml#s1')
    expect(doc.getElementById('pic')?.getAttribute('src')).toBe('images/a.png')
    expect(doc.querySelector('svg circle')).not.toBeNull()
  })

  it('sanitizes raw HTML handed directly to the second pass', () => {
    // A raw string handed to the second pass directly (e.g. if the first pass were skipped).
    const out = sanitizeSerializedSection(
      '<html><head></head><body><p>안전한 글</p><img src=x onerror=parent.pwned=1></body></html>'
    )
    const doc = new DOMParser().parseFromString(out, 'text/html')
    expectNoActiveContent(doc)
    expect(doc.body.textContent).toContain('안전한 글')
  })

  it('keeps standards mode when the section had a doctype', () => {
    const out = sanitizeSerializedSection(
      '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head></head><body><p>a</p></body></html>'
    )
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(new DOMParser().parseFromString(out, 'text/html').compatMode).toBe('CSS1Compat')
  })
})
