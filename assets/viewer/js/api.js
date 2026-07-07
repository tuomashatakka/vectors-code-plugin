// ---- server plumbing --------------------------------------------------------
const API = location.origin;

// project query-string helper: sep is '?' or '&'
export function projQ(sep, project){ return project ? sep+'project='+encodeURIComponent(project) : ''; }

async function getJSON(url){
  const r = await fetch(url);
  return r.json();
}

export const fetchProjects  = () => getJSON(API+'/api/projects');
export const fetchStatus    = project => getJSON(API+'/api/status'+projQ('?', project));
export const fetchGraph     = (project, n=600, k=3) => getJSON(API+`/api/graph?n=${n}&k=${k}`+projQ('&', project));
export const fetchInventory = (project, limit=200, offset=0) =>
  getJSON(API+`/api/inventory?limit=${limit}&offset=${offset}`+projQ('&', project));
export const fetchDoc = (id, project, full) =>
  getJSON(API+'/api/doc?id='+encodeURIComponent(id)+(full?'&full=1':'')+projQ('&', project));
export const fetchNode   = id => getJSON(API+'/api/node?id='+encodeURIComponent(id));
export const fetchSearch = (q, project) => getJSON(API+'/api/search?q='+encodeURIComponent(q)+projQ('&', project));
export const fetchIntents = (project, limit=100) => getJSON(API+`/api/intents?limit=${limit}`+projQ('&', project));
export const eventsURL = () => API+'/api/events';
