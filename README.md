# MV Cars

Sito vetrina auto con gestionale admin integrato, API Node e salvataggio dati su file JSON.

Il progetto include:

- sito pubblico in `index.html`
- pannello admin in `admin.html`
- server Node in `server.js`
- inventario in `data/cars.json`
- immagini caricate in `data/uploads/`
- credenziali admin in `data/admin-user.json`

## Come funziona

Il sito pubblico legge le auto dal file `data/cars.json`.

Il gestionale admin:

- fa login tramite API
- aggiunge, modifica ed elimina auto
- carica foto
- salva tutto nei file locali del progetto

Importante:

- il login e il salvataggio funzionano solo passando dal server Node
- se apri `index.html` o `admin.html` direttamente dal disco, il gestionale non funziona

## Cosa va settato

Queste sono le uniche cose davvero da configurare.

### Obbligatorio

- `Node.js` installato
- avvio del server con `npm start`

### Fortemente consigliato

- `ADMIN_PASSWORD`
  - se non la imposti, al primo avvio il server genera una password casuale e la stampa nel terminale
- `ADMIN_USERNAME`
  - opzionale, default `admin`

### Opzionale

- `HOST`
  - default `0.0.0.0`
- `PORT`
  - default `3000`
- `NODE_ENV`
  - consigliato `production` in deploy

## Variabili ambiente

| Variabile | Obbligatoria | Default | A cosa serve |
| --- | --- | --- | --- |
| `HOST` | no | `0.0.0.0` | indirizzo su cui ascolta il server |
| `PORT` | no | `3000` | porta HTTP del server |
| `ADMIN_USERNAME` | no | `admin` | username iniziale dell'admin |
| `ADMIN_PASSWORD` | no, ma consigliata | password casuale generata | password iniziale admin |
| `NODE_ENV` | no | vuota | utile in produzione |

## Avvio locale

1. Assicurati di avere Node.js installato
2. apri il progetto
3. avvia:

```bash
npm start
```

Poi apri:

- sito pubblico: `http://127.0.0.1:3000/`
- gestionale: `http://127.0.0.1:3000/admin.html`

## Avvio locale con credenziali impostate

### Windows PowerShell

```powershell
$env:ADMIN_PASSWORD="CAMBIA_QUESTA_PASSWORD"
npm start
```

### Linux / macOS

```bash
ADMIN_PASSWORD='CAMBIA_QUESTA_PASSWORD' npm start
```

## Primo accesso admin

Se `data/admin-user.json` non esiste:

- il server crea automaticamente l'utente admin
- usa `ADMIN_USERNAME` se lo hai impostato
- usa `ADMIN_PASSWORD` se la hai impostata
- altrimenti genera una password temporanea e la scrive nel terminale

Dopo il login puoi cambiare la password dal pannello admin.

In alternativa da terminale:

```bash
npm run set-admin-password -- NUOVA_PASSWORD
```

Puoi anche scegliere lo username:

```bash
npm run set-admin-password -- NUOVA_PASSWORD nuovo_username
```

## File importanti

### Dati pubblici

- `data/cars.json`
  - contiene le auto mostrate sul sito

### Dati privati

- `data/admin-user.json`
  - contiene username, hash password e sale
  - non va versionato

### Upload

- `data/uploads/`
  - contiene le foto caricate dal gestionale

## Cose da non fare

- non pubblicare `data/admin-user.json` su GitHub
- non usare GitHub Pages per il gestionale admin
- non aprire i file HTML direttamente dal disco se vuoi usare login e salvataggio

## Deploy

### GitHub Pages

Va bene solo per il sito pubblico statico.

Non va bene per:

- login admin
- upload foto
- API `/api/...`
- modifica inventario dal browser

### Google Compute Engine Free Tier

Se vuoi pubblicare il progetto completo tenendo:

- `npm start`
- API pubbliche
- login admin
- upload foto
- salvataggio su file locali

allora la strada consigliata per questo progetto e una VM Linux su Google Compute Engine Free Tier.

File pronti per il deploy:

- `deploy/gce/README.md`
- `deploy/gce/mvcars@.service`
- `deploy/gce/mvcars.nginx.conf`

Deploy raccomandato per questo setup:

- upload ZIP del progetto sulla VM
- estrazione in `~/mvCars-main`
- credenziali in `~/mvCars-main/.env`
- service `systemd` avviato come `mvcars@$USER`

## Checklist deploy Google Compute Engine

Questa e la checklist minima da sapere prima del deploy.

### Da configurare nella VM

- Node.js
- npm
- nginx
- git

### Configurazione consigliata per restare nel free tier

- macchina `e2-micro`
- regione `us-west1`, `us-central1` oppure `us-east1`
- disco `Standard persistent disk`

### Da aprire a livello rete

- porta `22` per SSH
- porta `80` per HTTP
- porta `443` per HTTPS futuro

### Da configurare nel servizio

- file `~/mvCars-main/.env`
- `ADMIN_PASSWORD=...`
- opzionale `ADMIN_USERNAME=...`

Il resto e' gia' definito dal service template:

- `HOST=0.0.0.0`
- `PORT=3000`
- `NODE_ENV=production`

### Da tenere persistente sul disco

- cartella `data/`

Dentro `data/` restano:

- inventario
- utente admin
- foto caricate

## Aggiornamenti futuri

Quando aggiorni il progetto in produzione:

```bash
cd ~/mvCars-main
npm install
sudo systemctl restart mvcars@$USER
```

## Script disponibili

```bash
npm start
npm run dev
npm run set-admin-password -- NUOVA_PASSWORD [username]
npm run scrape
```

## Scraper

Lo script `scripts/scrape.py` e separato dal gestionale.

Serve solo se vuoi importare o recuperare dati da fonti esterne. Non e necessario per far funzionare il sito o l'admin.

## Supporto rapido

Se qualcosa non parte, controlla prima queste tre cose:

1. il server e avviato con `npm start`
2. `data/admin-user.json` esiste oppure hai impostato `ADMIN_PASSWORD`
3. stai aprendo il sito tramite server e non da file locale
