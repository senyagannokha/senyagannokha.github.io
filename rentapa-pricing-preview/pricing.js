/* Internal equipment price reference. Requires admin/index.html helpers and Supabase auth. */
(function(root){
"use strict";
var prices = null;
var loading = null;
var writes = new Map();
var categoryFilter = "";
var searchFilter = "";
var onlyMissing = false;
var MONEY = ["price_day_1","price_day_7","price_day_14","price_day_30_plus","operator_day"];
var EDITABLE = ["category_name","equipment_name","configuration"].concat(MONEY,["notes"]);
var LABEL = {category_name:"Categoria",equipment_name:"Equipamento",configuration:"Classe / configuração",
  price_day_1:"1 dia",price_day_7:"7 dias",price_day_14:"14 dias",
  price_day_30_plus:"30+ dias",operator_day:"Manobrador / dia",notes:"Notas"};

function catalogueRows(){
  var rows = [];
  (REF.categories||[]).forEach(function(c){
    (c.items||[]).forEach(function(i){
      var sizes = i.sz && i.sz.length ? i.sz : [""];
      sizes.forEach(function(s){
        rows.push({catalog_key:"catalog:"+i.s+":"+s,category_slug:c.s,category_name:c.n,
          equipment_slug:i.s,equipment_name:i.n,configuration:s,is_custom:false,
          price_day_1:null,price_day_7:null,price_day_14:null,price_day_30_plus:null,
          operator_day:null,notes:""});
      });
    });
  });
  return rows;
}
function mergedRows(records){
  var byKey = new Map(records.map(function(r){return [r.catalog_key,r];}));
  var rows = catalogueRows().map(function(r){
    var found = byKey.get(r.catalog_key);
    byKey.delete(r.catalog_key);
    return found ? Object.assign(r,found) : r;
  });
  // Preserve renamed catalogue rows and independently added equipment.
  byKey.forEach(function(r){rows.push(r);});
  return rows.sort(function(a,b){
    return String(a.category_name||"").localeCompare(String(b.category_name||""),"pt") ||
      String(a.equipment_name||"").localeCompare(String(b.equipment_name||""),"pt") ||
      String(a.configuration||"").localeCompare(String(b.configuration||""),"pt");
  });
}
async function loadPricing(force){
  if(prices&&!force)return prices;
  if(loading)return loading;
  loading = fetchAll("equipment_price_points","select=*&order=catalog_key.asc")
    .then(function(records){prices=mergedRows(records);return prices;})
    .finally(function(){loading=null;});
  return loading;
}
function valueForInput(row,key){
  return row[key]===null||row[key]===undefined?"":String(row[key]);
}
function cleanNumber(s){
  var raw=String(s||"").trim().replace(/\s/g,"").replace(",",".");
  if(!raw)return null;
  var n=Number(raw);
  if(!Number.isFinite(n)||n<0||n>99999999||Math.round(n*100)/100!==n)throw new Error("Introduza um valor positivo em euros, até 2 casas decimais.");
  return n;
}
function rowEndpoint(key){
  // PostgREST requires double-quoted filter values for commas, quotes and parentheses.
  var quoted='"'+String(key).replace(/\\/g,"\\\\").replace(/"/g,'\\"')+'"';
  return "equipment_price_points?catalog_key=eq."+encodeURIComponent(quoted);
}
function payload(row){
  var data={catalog_key:row.catalog_key,category_slug:row.category_slug,
    category_name:row.category_name||"Sem categoria",equipment_slug:row.equipment_slug||"",
    equipment_name:row.equipment_name||"Novo equipamento",configuration:row.configuration||"",
    notes:row.notes||"",is_custom:!!row.is_custom};
  MONEY.forEach(function(k){data[k]=row[k]==null?null:Number(row[k]);});
  return data;
}
function persist(row,field,next,control){
  var key=row.catalog_key;
  var previous=writes.get(key)||Promise.resolve();
  var task=previous.catch(function(){}).then(async function(){
    var before=row[field];
    if(before===next)return;
    row[field]=next;
    control.disabled=true;
    control.classList.remove("price-error");
    control.classList.add("price-saving");
    try {
      var changed=await api(rowEndpoint(key),{
        method:"PATCH",body:Object.assign({updated_at:new Date().toISOString()},{[field]:next}),prefer:"return=representation"
      });
      if(!changed||!changed.length){
        await api("equipment_price_points?on_conflict=catalog_key",{
          method:"POST",body:payload(row),prefer:"resolution=merge-duplicates,return=representation"
        });
      }
      control.classList.remove("price-saving");
      control.classList.add("price-saved");
      control.title="Guardado no Supabase";
    }catch(e){
      row[field]=before;
      control.value=valueForInput(row,field);
      control.classList.add("price-error");
      control.title="Erro ao guardar: "+e.message;
      toast("Não foi possível guardar: "+e.message.slice(0,110));
    }finally{
      control.disabled=false;
      if(document.activeElement===control)control.select();
    }
  });
  writes.set(key,task);
  task.finally(function(){if(writes.get(key)===task)writes.delete(key);});
}
function editor(row,field){
  var numeric=MONEY.indexOf(field)!==-1;
  var input=el("input",{class:"price-input"+(numeric?" amount":""),type:"text",
    inputmode:numeric?"decimal":"text",value:valueForInput(row,field),
    "aria-label":LABEL[field]+" — "+row.equipment_name+" "+row.configuration,
    title:"Alterar e sair da célula para guardar"});
  input.addEventListener("change",function(){
    var next;
    try{
      next=numeric?cleanNumber(input.value):input.value.trim();
      if(field==="equipment_name"&&!next)throw new Error("O nome do equipamento não pode ficar vazio.");
    }catch(e){input.classList.add("price-error");input.title=e.message;toast(e.message);return;}
    persist(row,field,next,input);
  });
  input.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();input.blur();}});
  return input;
}
function isMissing(row){return MONEY.slice(0,4).some(function(k){return row[k]==null;});}
function visibleRows(){
  return (prices||[]).filter(function(r){
    if(categoryFilter&&r.category_name!==categoryFilter)return false;
    if(onlyMissing&&!isMissing(r))return false;
    return !searchFilter||norm([r.category_name,r.equipment_name,r.configuration,r.notes].join(" ")).includes(norm(searchFilter));
  });
}
function toCsv(){
  var cols=["category_name","equipment_name","configuration"].concat(MONEY,["notes"]);
  var lines=[cols.map(function(x){return LABEL[x];})];
  visibleRows().forEach(function(r){lines.push(cols.map(function(k){return valueForInput(r,k);}));});
  function escapeCsv(s){s=String(s).replace(/^[=+@\-\t\r]/,"'$&");return '"'+s.replace(/"/g,'""')+'"';}
  var csv="\ufeff"+lines.map(function(a){return a.map(escapeCsv).join(";");}).join("\r\n");
  var url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  var a=document.createElement("a");a.href=url;a.download="rentapa-precos-internos.csv";document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);},2000);
}
function renderTable(holder,stats){
  holder.innerHTML="";
  var all=prices||[], rows=visibleRows(), priced=all.filter(function(r){return MONEY.slice(0,4).some(function(k){return r[k]!=null;});}).length;
  stats.textContent=rows.length+" linhas apresentadas de "+all.length+" · "+priced+" com pelo menos uma tarifa";
  if(!rows.length){holder.appendChild(el("p",{class:"empty",text:"Sem resultados para os filtros escolhidos."}));return;}
  var head=["Categoria","Equipamento","Classe / configuração","1 dia","7 dias","14 dias","30+ dias","Manobrador / dia","Notas",""];
  var thead=el("thead",null,[el("tr",null,head.map(function(h,j){
    var th=el("th",{text:h});if(j>=3&&j<=7)th.title="€ por dia (sem IVA) para alugueres desta duração";return th;
  }))]);
  var tbody=el("tbody");
  rows.forEach(function(r){
    var tr=el("tr",null,EDITABLE.map(function(k){
      return el("td",{class:MONEY.indexOf(k)>=0?"price-number":""},[editor(r,k)]);
    }));
    var button=r.is_custom?el("button",{class:"btn small",type:"button",text:"Eliminar",
      "aria-label":"Eliminar "+r.equipment_name+" "+r.configuration,onclick:async function(){
        if(!confirm("Eliminar esta linha personalizada? Esta ação não pode ser anulada."))return;
        button.disabled=true;
        try{
          await api(rowEndpoint(r.catalog_key),{method:"DELETE"});
          prices=prices.filter(function(x){return x.catalog_key!==r.catalog_key;});
          renderTable(holder,stats);toast("Linha eliminada");
        }catch(e){button.disabled=false;toast("Erro: "+e.message);}
      }}):el("span",{class:"note",text:"Catálogo"});
    tr.appendChild(el("td",null,[button]));
    tbody.appendChild(tr);
  });
  holder.appendChild(el("table",{class:"price-grid"},[thead,tbody]));
}
function viewPricing(){
  var c=$("content");
  c.innerHTML="";
  var outer=el("div",{class:"card price-page"});
  outer.appendChild(el("h2",{class:"price-title",text:"Tabela interna de preços"}));
  outer.appendChild(el("p",{class:"note",text:"Valores de referência em € por dia, sem IVA e sem transporte. Colunas 1/7/14/30+ = tarifa diária conforme a duração do aluguer; manobrador = custo adicional aproximado por dia. Campos vazios significam preço ainda não definido. Edite qualquer célula e saia dela para guardar automaticamente."}));
  var toolsBar=el("div",{class:"filters price-toolbar"});
  var search=el("input",{type:"search",placeholder:"Pesquisar equipamento ou classe…",value:searchFilter,
    "aria-label":"Pesquisar preços"}),categories=el("select",{"aria-label":"Filtrar categoria"}),
    missing=el("input",{type:"checkbox"});
  missing.checked=onlyMissing;
  var stat=el("span",{class:"note",role:"status"});
  var tableWrap=el("div",{class:"tbl-wrap price-scroll",role:"region","aria-label":"Tabela de preços de equipamentos",tabindex:"0"});
  function refresh(){renderTable(tableWrap,stat);}
  var unique=[...new Set((prices||[]).map(function(r){return r.category_name;}))].sort(function(a,b){return a.localeCompare(b,"pt");});
  categories.appendChild(el("option",{value:"",text:"Todas as categorias"}));
  unique.forEach(function(n){categories.appendChild(el("option",{value:n,text:n}));});
  categories.value=categoryFilter;
  search.addEventListener("input",function(){searchFilter=search.value;refresh();});
  categories.addEventListener("change",function(){categoryFilter=categories.value;refresh();});
  missing.addEventListener("change",function(){onlyMissing=missing.checked;refresh();});
  toolsBar.appendChild(search);toolsBar.appendChild(categories);
  toolsBar.appendChild(el("label",{class:"chk"},[missing," Apenas tarifas incompletas"]));
  toolsBar.appendChild(el("span",{class:"spacer"}));
  toolsBar.appendChild(el("button",{class:"btn primary",type:"button",text:"+ Equipamento",onclick:async function(){
    var name=prompt("Nome do novo equipamento (linha personalizada):");
    if(!name||!name.trim())return;
    var category=categoryFilter||"Outros",key="custom:"+crypto.randomUUID();
    var r={catalog_key:key,category_slug:"personalizado",category_name:category,
      equipment_slug:"",equipment_name:name.trim(),configuration:"",is_custom:true,
      price_day_1:null,price_day_7:null,price_day_14:null,price_day_30_plus:null,operator_day:null,notes:""};
    try{
      await api("equipment_price_points",{method:"POST",body:payload(r),prefer:"return=representation"});
      prices.push(r);onlyMissing=false;missing.checked=false;searchFilter="";search.value="";
      categoryFilter="";categories.value="";viewPricing();toast("Equipamento adicionado");
    }catch(e){toast("Erro ao adicionar: "+e.message);}
  }}));
  toolsBar.appendChild(el("button",{class:"btn",type:"button",text:"Exportar CSV",onclick:toCsv}));
  toolsBar.appendChild(el("button",{class:"btn",type:"button",text:"Atualizar preços",onclick:async function(){
    try{await loadPricing(true);viewPricing();toast("Preços atualizados");}catch(e){toast("Erro: "+e.message);}
  }}));
  outer.appendChild(toolsBar);outer.appendChild(stat);outer.appendChild(tableWrap);c.appendChild(outer);
  if(!prices){tableWrap.appendChild(el("p",{class:"empty",text:"A carregar preços…"}));
    loadPricing(false).then(function(){if(S.tab==="pricing")viewPricing();}).catch(function(e){
      tableWrap.innerHTML="";tableWrap.appendChild(el("p",{class:"status-row bad",text:"Não foi possível carregar a tabela: "+e.message}));
    });
  }else refresh();
}
root.viewPricing=viewPricing;
})(window);
