// The signed-in user, in the top bar.

export function renderUser(user) {
  document.getElementById('userName').textContent = user.displayName;
  if (user.avatarUrl) document.getElementById('avatar').src = user.avatarUrl;
}
