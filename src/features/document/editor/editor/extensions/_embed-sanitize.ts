   
                           
                                       
                                                  
  
                                                 
   

export function sanitizeEmbed(root: HTMLElement): void {
  root.querySelectorAll('script, iframe, object, embed').forEach((el) => el.remove())
  root.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('tabindex', '-1')
    a.addEventListener('click', (e) => e.preventDefault())
  })
}
