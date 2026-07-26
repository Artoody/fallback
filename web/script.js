const WEBHOOK =
"https://YOUR-N8N/webhook/sensor";

function random(min,max){
    return Math.floor(Math.random()*(max-min+1))+min;
}

function randomData(){

document.getElementById("temp").value=random(15,45);

document.getElementById("hum").value=random(20,90);

document.getElementById("pres").value=random(980,1035);

document.getElementById("alt").value=random(0,300);

document.getElementById("battery").value=random(20,100);

}

async function sendData(){

const data={

deviceId:"ESP32-01",

timestamp:new Date().toISOString(),

sensor:{

temperature:Number(temp.value),

humidity:Number(hum.value),

pressure:Number(pres.value),

altitude:Number(alt.value),

battery:Number(battery.value)

},

status:status.value

};

const res=await fetch(WEBHOOK,{
method:"POST",
headers:{
"Content-Type":"application/json"
},
body:JSON.stringify(data)
});

const json=await res.json();

document.getElementById("result").textContent=
JSON.stringify(json,null,2);

}