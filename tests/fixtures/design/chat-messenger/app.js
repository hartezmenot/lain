// Chat messenger — a tiny multi-page app (the LAIN Design fixture).

// Home: tapping my avatar opens my profile.
var me = document.getElementById('me');
if (me) {
  me.addEventListener('click', function () {
    location.href = 'profile.html';
  });
}
