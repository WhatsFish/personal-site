// Inject the Umami analytics tracker into the <head> of every page.
hexo.extend.injector.register(
  'head_end',
  '<script defer src="http://20.89.176.30:3000/script.js" data-website-id="3816fe35-fc57-4516-81b7-25fcf6856c9f"></script>',
  'default'
);
