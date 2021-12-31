# Usage of subcomponents

```svelte
<!-- App.svelte -->
<script>
    const links = ['/home', '/contact', '/about'];
</script>

{#component NavLink}
    <script>
        export let link;
    </script>

    <a href={link}>

    <style>
        a {
            color: red;
        }
    </style>
{/component}


<nav>
    {#each links as link}
        <NavLink {link} />
    {/each}
</nav>
```