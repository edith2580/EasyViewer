import JSZip from 'jszip'

/**
 * Generates a rich Korean sample TXT book (UTF-8) for immediate testing
 */
export function createSampleTxtBook(): ArrayBuffer {
  const content = `제1장 메밀꽃 필 무렵 - 이효석

여름장이란 애시당초에 글러서, 해는 아직 중천에 있건만 장판은 벌써 쓸쓸하고 더운 햇발이 벌여 놓은 전 휘장 밑으로 등줄기를 훅훅 볶는다. 마을 사람들은 거지반 돌아간 뒤요, 팔리지 못한 나무꾼패가 길거리에 궁싯거리고들 있으나 석유병이나 받고 고깃마리나 사면 족할 이 축들을 바라고 언제까지든지 버티고 있을 법은 없다. 춥춥스럽게 날아드는 파리떼도 장난꾼 각다귀들도 귀찮다. 얼금뱅이요 왼손잡이인 드팀전 허생원은 기어코 동업의 조선달을 낚아보았다.

"그만 거둘까?"
"잘 생각했네. 봉평장에서 한 번이나 흐뭇하게 사본 일 있었을까. 내일 대화장에서나 한몫 벌어야겠네."
"오늘 밤은 밤을 새서 걸어야 될걸?"
"달이 뜨렷다?"

절렁절렁 소리를 내며 나귀가 하품을 한다. 허생원은 계집과는 연분이 멀었다. 얽은 상판대기가 부끄러워서가 아니라 성미가 본시 숫기가 없어서였다. 그러나 젊은 시절 봉평 물레방앗간에서 만났던 성서방네 처녀만큼은 평생 잊을 수가 없었다.

제2장 달빛 아래의 밤길

산길로 접어드니 달빛이 쏟아져 내렸다. 이지러는 졌으나 보름을 갓 지난 달은 부드러운 빛을 흐붓이 흘리고 있다. 대화까지는 칠십 리 밤길, 고개를 둘이나 넘고 개울을 하나 건너고 벌판과 산길을 걸어야 된다.

길은 지금 긴 산허리에 걸려 있다. 밤중을 지난 무렵인지 죽은 듯이 고요한 속에서 짐승 같은 달의 숨소리가 손에 잡힐 듯이 들리며, 콩포기와 옥수수 잎새가 한층 달에 푸르게 젖었다. 산허리는 온통 메밀밭이어서 피기 시작한 꽃이 소금을 뿌린 듯이 흐붓한 달빛에 숨이 막힐 지경이다.

붉은 대궁이 향기같이 애잔하고 나귀들의 걸음도 시원하다. 길이 좁은 까닭에 세 사람은 나귀를 타고 외줄로 늘어섰다. 방울소리가 시원스럽게 딸랑딸랑 메밀밭께로 흘러간다. 앞장선 허생원의 이야기 소리는 꽁무니의 동이에게는 확적히는 안 들렸으나, 그는 그대로 개운한 제 멋에 적적하지는 않았다.

"달밤에는 그런 이야기가 격에 맞거든."
조선달 편을 바라는 보았으나 물론 미안해서가 아니라 달빛에 감동하여서였다.

제3장 물레방앗간의 추억과 동이

"장선 꼭 이런 날 밤이었네. 객줏집 토방이란 무더워서 잠이 들어야지. 밤중은 돼서 혼자 일어나 개울가에 목욕하러 나갔지. 봉평은 지금이나 그제나 마찬가지나 보이는 곳마다 메밀밭이어서 개울가도 하얀 꽃이었네."

허생원은 이야기를 이어 나갔다. 성서방네 처녀와 맺은 하룻밤의 인연, 그리고 그 뒤로 제천 장판을 떠돌며 처녀의 소식을 찾아 헤맨 세월이 주마등처럼 스쳐 지나갔다.

개울을 건너면서 허생원이 발을 헛디뎌 물에 빠졌을 때, 젊은 장돌뱅이 동이가 허생원을 넓적하게 업어 올렸다. 동이의 어머니 고향도 봉평이요, 아버지는 얼굴도 모른 채 자랐다는 이야기에 허생원의 가슴은 쿵 내려앉았다.

"동이 자네도 왼손잡이인가?"
나귀를 몰던 동이의 채찍이 왼손에 들려 있는 것을 본 허생원의 눈시울이 뜨거워졌다. 제천으로 향하는 달밤의 메밀밭 길 위로 세 사람의 그림자가 나란히 이어졌다.
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

