# Chatwoot WooCommerce Flow Panel Pro Chile v5

Panel interno para Chatwoot con WooCommerce, Flow, checkout chileno, RUT, regiones/comunas, variaciones visuales, Redis y PostgreSQL.

## Mejoras v5

- Interfaz nueva tipo app para usar dentro de Chatwoot.
- Carga más rápida: ya no intenta cargar todo el catálogo completo al abrir.
- Búsqueda por nombre, SKU, atributo, variación, categoría y oferta.
- Botón **Ver más productos** con paginación.
- Loader circular y skeleton visual de carga.
- Variaciones mejoradas con selector por atributos, por ejemplo Color y Talla.
- Al seleccionar variación cambia imagen, SKU, stock y precio.
- Oculta atributos/metadatos basura como `size_info`, datos AliExpress largos, shipping, origen, etc.
- Dockerfile y Docker Compose con Redis y PostgreSQL separados.
- Redis para caché rápido.
- PostgreSQL para índice local de productos.
- Botón **Sincronizar catálogo** para traer WooCommerce + variaciones al índice local.
- Compatible con EasyPanel, CloudPanel o Docker Compose.

## Variables de entorno

Copia `.env.example` como `.env` o pega estas variables en EasyPanel:

```env
PORT=3000
PUBLIC_BASE_URL=https://panel.tudominio.cl

PANEL_USER=admin
PANEL_PASSWORD=admin123

WC_URL=https://tutienda.cl
WC_KEY=ck_xxxxxxxxxxxxxxxxx
WC_SECRET=cs_xxxxxxxxxxxxxxxxx

FLOW_API_URL=https://sandbox.flow.cl/api
FLOW_API_KEY=xxxxxxxxxxxxxxxxx
FLOW_SECRET_KEY=xxxxxxxxxxxxxxxxx
FLOW_PAYMENT_METHOD=9

CHATWOOT_URL=https://chat.tudominio.cl
CHATWOOT_API_KEY=xxxxxxxxxxxxxxxxx
CHATWOOT_ACCOUNT_ID=1

REDIS_URL=redis://redis:6379
DATABASE_URL=postgres://panel:panel_password@postgres:5432/paneldb
CACHE_TTL_PRODUCTS_MS=1800000
CACHE_TTL_CLIENTE_MS=120000
VARIATION_CONCURRENCY=6
DEFAULT_POSTCODE=8320000
REQUIRE_RUT=true
```

## Instalación simple con Node

```bash
npm install
npm start
```

## Instalación recomendada con Docker Compose

```bash
docker compose up -d --build
```

Esto levanta:

- `panel` en puerto `3000`
- `redis`
- `postgres`

## EasyPanel recomendado

Opción 1, más robusta: usar **Dockerfile** o **Docker Compose**.

Opción 2, Nixpacks:

- Install command: `npm install`
- Start command: `node server.js`
- Port: `3000`

Para Redis y PostgreSQL en EasyPanel crea dos servicios adicionales:

- Redis
- PostgreSQL

Luego agrega en el panel:

```env
REDIS_URL=redis://usuario:password@host:6379
DATABASE_URL=postgres://usuario:password@host:5432/basedatos
```

Si usas el `docker-compose.yml`, ya vienen conectados como:

```env
REDIS_URL=redis://redis:6379
DATABASE_URL=postgres://panel:panel_password@postgres:5432/paneldb
```

## Flujo recomendado

1. Desplegar la app.
2. Entrar con Basic Auth y login visual.
3. Ir a productos.
4. Presionar **Sincronizar catálogo** una vez.
5. Desde ese momento la búsqueda queda rápida por PostgreSQL y Redis.
6. Usar “Ver más productos” para paginar.

## Integración como App/Panel en Chatwoot

Registra la URL de la app en Chatwoot usando parámetros de conversación/contacto, por ejemplo:

```text
https://panel.tudominio.cl/?email={{contact.email}}&conversation_id={{conversation.id}}
```

También acepta:

```text
?email_cliente=cliente@correo.cl&conversation_id=123
?customer_email=cliente@correo.cl&conversationId=123
```

El panel lee esos datos, carga el cliente, permite enviar productos a la conversación y aplicar etiquetas.

## Seguridad

- Todo el panel está protegido por HTTP Basic Auth.
- También tiene login visual interno.
- No subas `.env` real a Git.
- Usa `.env.example` para referencia.

## Actualizar en el mismo Git

```bash
git add .
git commit -m "Upgrade panel v5 with docker redis postgres and better Chatwoot app UI"
git push
```

Luego en EasyPanel presiona **Deploy**.
