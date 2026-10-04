<script>
  let { children } = $props();
</script>

<header class="topbar">
  <h1 class="title">Chats</h1>
  <img id="me" class="me" src="/me.svg" alt="Me">
</header>
{@render children()}

<style>
  .topbar { position: relative; height: 64px; padding: 16px; }
  .title { margin: 0; font-size: 22px; }
  .me { position: absolute; top: 12px; right: 16px; width: 40px; height: 40px; border-radius: 50%; }
</style>
