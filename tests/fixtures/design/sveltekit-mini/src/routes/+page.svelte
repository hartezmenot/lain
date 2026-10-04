<script>
  const friends = ['Ada', 'Grace', 'Linus'];
</script>

<ul class="friends">
  {#each friends as f}
    <li class="friend">{f}</li>
  {/each}
</ul>
<a class="go" href="/settings">Settings</a>

<style>
  .friends { display: flex; flex-direction: column; gap: 8px; list-style: none; margin: 0; padding: 12px 16px; }
  .friend { padding: 8px; border-radius: 12px; background: #ffffff; }
</style>
