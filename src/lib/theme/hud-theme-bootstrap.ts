/** Runs before paint to avoid theme flash (reads zustand persist shape). */
export const HUD_THEME_BOOTSTRAP = `(function(){try{var r=localStorage.getItem("juno-hud-prefs");if(!r)return;var s=JSON.parse(r).state;if(s&&s.theme)document.documentElement.dataset.hudTheme=s.theme}catch(e){}})();`;
