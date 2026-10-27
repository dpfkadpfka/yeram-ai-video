// 예람쌤 AI 영상 제작소 — 커뮤니티 새 글 지메일 알림
// 1) script.google.com → 새 프로젝트 → 이 코드 붙여넣기
// 2) 아래 KEY를 아무 긴 글자로 바꾸기 (Cloudflare MAIL_KEY와 같게)
// 3) 배포 → 새 배포 → 유형: 웹 앱 / 실행: 나 / 액세스: 모든 사용자 → 배포 → 권한 허용
// 4) 나온 웹 앱 URL을 Cloudflare MAIL_HOOK에 넣기
const KEY = "여기에-긴-비밀-문구";
function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents || "{}");
    if (d.key !== KEY) return ContentService.createTextOutput("no");
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), String(d.subject || "[AI 영상 제작소] 새 글").slice(0, 200), String(d.text || "").slice(0, 5000));
    return ContentService.createTextOutput("ok");
  } catch (err) { return ContentService.createTextOutput("err"); }
}
