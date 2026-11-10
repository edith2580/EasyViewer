import JSZip from 'jszip'

/**
 * Generates a rich Korean sample TXT book (UTF-8) for immediate testing
 */
export function createSampleTxtBook(): ArrayBuffer {
  const content = `윤동주 시선 - 별 헤는 밤

  계절이 지나가는 하늘에는 가을로 가득 차 있습니다.

  나는 아무 걱정도 없이 가을 속의 별들을 다 헤일 듯합니다.

  가슴 속에 하나 둘 새겨지는 별을 이제 다 못 헤는 것은 쉬이 아침이 오는 까닭이요, 내일 밤이 남은 까닭이요, 아직 나의 청춘이 다하지 않은 까닭입니다.

  별 하나에 추억과 별 하나에 사랑과 별 하나에 쓸쓸함과 별 하나에 동경과 별 하나에 시와 별 하나에 어머니, 어머니,

  어머님, 나는 별 하나에 아름다운 말 한마디씩 불러 봅니다. 소학교 때 책상을 같이 했던 아이들의 이름과, 패, 경, 옥, 이런 이국 소녀들의 이름과, 벌써 아기 어머니 된 계집애들의 이름과, 가난한 이웃 사람들의 이름과, 비둘기, 강아지, 토끼, 노새, 노루, 프랑시스 잠, 라이너 마리아 릴케, 이런 시인의 이름을 불러 봅니다.
`
  return new TextEncoder().encode(content).buffer
}

/**
 * Dynamically creates a valid EPUB 2/3 archive in memory using JSZip
 * so the user can test EPUB TOC, Chapter navigation, Search, Themes, and CFI bookmarking immediately.
 */
export async function createSampleEpubBook(): Promise<ArrayBuffer> {
  const zip = new JSZip()

  // mimetype must be first and uncompressed
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  )

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>EasyViewer 완벽 가이드 및 샘플 북</dc:title>
    <dc:creator>EasyViewer Team</dc:creator>
    <dc:language>ko</dc:language>
    <dc:identifier id="BookId">urn:uuid:easyviewer-sample-epub-001</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`
  )

  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:easyviewer-sample-epub-001"/>
  </head>
  <docTitle><text>EasyViewer 완벽 가이드 및 샘플 북</text></docTitle>
  <navMap>
    <navPoint id="navPoint-1" playOrder="1">
      <navLabel><text>1장. EasyViewer 소개 및 핵심 기능</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-2" playOrder="2">
      <navLabel><text>2장. 맞춤 독서 옵션과 테마 설정</text></navLabel>
      <content src="chapter2.xhtml"/>
    </navPoint>
    <navPoint id="navPoint-3" playOrder="3">
      <navLabel><text>3장. 윤동주 시선 - 별 헤는 밤</text></navLabel>
      <content src="chapter3.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`
  )

  zip.file(
    'OEBPS/chapter1.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ko">
<head><title>1장. EasyViewer 소개 및 핵심 기능</title></head>
<body>
  <h1>1장. EasyViewer 소개 및 핵심 기능</h1>
  <p><strong>EasyViewer</strong>는 텍스트(TXT)와 전자책(EPUB)을 모든 플랫폼(Windows, macOS, Android, iOS, Web)에서 쾌적하게 읽을 수 있도록 설계된 범용 문서 뷰어입니다.</p>
  <p>상단 툴바의 <strong>목차</strong> 버튼을 눌러 원하는 챕터로 즉시 이동할 수 있으며, <strong>통합 검색</strong> 기능을 사용해 문서 전체에서 원하는 키워드를 빠르게 찾고 하이라이트된 위치로 이동할 수 있습니다.</p>
  <p>또한 읽던 위치는 실시간으로 저장되며, 원격 동기화 기능을 통해 다른 기기에서도 마지막으로 읽던 페이지부터 이어서 독서를 즐길 수 있습니다.</p>
</body>
</html>`
  )

  zip.file(
    'OEBPS/chapter2.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ko">
<head><title>2장. 맞춤 독서 옵션과 테마 설정</title></head>
<body>
  <h1>2장. 맞춤 독서 옵션과 테마 설정</h1>
  <p>독서 환경에 맞춰 두 가지 보기 방식을 자유롭게 전환해 보세요:</p>
  <ul>
    <li><strong>가로 페이지 넘김 모드</strong>: 종이책을 넘기듯 좌우 버튼이나 키보드 화살표(←/→), 화면 좌우 터치로 페이지를 넘깁니다.</li>
    <li><strong>세로 스크롤 모드</strong>: 웹소설이나 문서를 읽듯 위아래로 자연스럽게 스크롤하며 읽을 수 있습니다.</li>
  </ul>
  <p>눈의 피로를 줄여주는 <strong>다크 모드</strong>와 따뜻한 종이 질감의 <strong>세피아 모드</strong>를 지원하며, 글꼴 종류(고딕, 명조, 코딩체), 글자 크기, 줄 간격, 여백을 실시간으로 조절할 수 있습니다.</p>
</body>
</html>`
  )

  zip.file(
    'OEBPS/chapter3.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ko">
<head><title>3장. 윤동주 시선 - 별 헤는 밤</title></head>
<body>
  <h1>3장. 윤동주 시선 - 별 헤는 밤</h1>
  <p>계절이 지나가는 하늘에는 가을로 가득 차 있습니다.</p>
  <p>나는 아무 걱정도 없이 가을 속의 별들을 다 헤일 듯합니다.</p>
  <p>가슴 속에 하나 둘 새겨지는 별을 이제 다 못 헤는 것은 쉬이 아침이 오는 까닭이요, 내일 밤이 남은 까닭이요, 아직 나의 청춘이 다하지 않은 까닭입니다.</p>
  <p>별 하나에 추억과 별 하나에 사랑과 별 하나에 쓸쓸함과 별 하나에 동경과 별 하나에 시와 별 하나에 어머니, 어머니,</p>
  <p>어머님, 나는 별 하나에 아름다운 말 한마디씩 불러 봅니다. 소학교 때 책상을 같이 했던 아이들의 이름과, 패, 경, 옥, 이런 이국 소녀들의 이름과, 벌써 아기 어머니 된 계집애들의 이름과, 가난한 이웃 사람들의 이름과, 비둘기, 강아지, 토끼, 노새, 노루, 프랑시스 잠, 라이너 마리아 릴케, 이런 시인의 이름을 불러 봅니다.</p>
</body>
</html>`
  )

  return await zip.generateAsync({ type: 'arraybuffer' })
}

