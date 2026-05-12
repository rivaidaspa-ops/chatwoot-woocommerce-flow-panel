# Chatwoot WooCommerce Flow Panel Pro Chile v4

Panel Node.js + Express protegido con Basic Auth y login visual. Integra WooCommerce, Flow, Chatwoot, RUT chileno, Región → Comuna, códigos postales, productos variables, imágenes de variación, Redis y PostgreSQL opcionales para acelerar tiendas grandes.

## Mejoras v4

- Redis opcional para caché rápido de productos/clientes.
- PostgreSQL opcional para índice local de productos.
- Búsqueda rápida por nombre, SKU, variación, atributo, etiqueta y categoría.
- Filtro por categoría.
- Filtro “Solo ofertas”.
- Filtro “Solo con stock”.
- Carga paginada: no renderiza todo de una sola vez.
- Botón “Cargar más productos”.
- Botón “Sincronizar catálogo” para traer WooCommerce, guardar caché e indexar.
- Loader visual circular mientras carga.
- Mantiene RUT, comunas, códigos postales, Flow, Chatwoot y variaciones.

## Variables de entorno

```env
PORT=3000
PUBLIC_BASE_URL=https://panel.tudominio.cl
ALLOWED_ORIGINS=

PANEL_USER=admin
PANEL_PASSWORD=admin123

WC_URL=https://tutienda.cl
WC_KEY=ck_xxxxxxxxxxxxxxxxx
WC_SECRET=cs_xxxxxxxxxxxxxxxxx

FLOW_API_URL=https://sandbox.flow.cl/api
FLOW_API_KEY=xxxxxxxxxxxxxxxxx
FLOW_SECRET_KEY=xxxxxxxxxxxxxxxxx
FLOW_PAYMENT_METHOD=9
FLOW_URL_CONFIRMATION=https://panel.tudominio.cl/flow/confirmacion
FLOW_URL_RETURN=https://panel.tudominio.cl/flow/retorno

CHATWOOT_URL=https://chat.tudominio.cl
CHATWOOT_API_KEY=xxxxxxxxxxxxxxxxx
CHATWOOT_ACCOUNT_ID=1

REQUIRE_RUT=true
DEFAULT_POSTCODE=8320000
CACHE_TTL_PRODUCTS_MS=900000
CACHE_TTL_CLIENTE_MS=60000

# Recomendado para velocidad
REDIS_URL=redis://redis:6379
DATABASE_URL=postgresql://panel_user:panel_password@postgres:5432/chatwoot_panel
PG_POOL_MAX=5
VARIATION_CONCURRENCY=4
```

## EasyPanel recomendado

1. Mantén tu app Node con Nixpacks.
2. Crea un servicio Redis.
3. Crea un servicio PostgreSQL.
4. Copia las URLs internas de Redis y PostgreSQL a las variables `REDIS_URL` y `DATABASE_URL`.
5. En la app usa:
   - Install command: `npm install`
   - Build command: vacío
   - Start command: `node server.js`
   - Port: `3000`

Si no configuras Redis/PostgreSQL, la app funciona igual usando memoria interna, pero la búsqueda será menos rápida cuando WooCommerce tenga muchos productos.

## Flujo recomendado tras desplegar

1. Entra al panel.
2. Presiona “Sincronizar catálogo”.
3. Espera a que termine la primera carga.
4. Luego las búsquedas por nombre/SKU/categoría/oferta serán mucho más rápidas.

## Chatwoot App Panel

Registra:

```text
https://panel.tudominio.cl/?email={{contact.email}}&conversation_id={{conversation.id}}
```

## Endpoints principales

- `GET /cliente?email=cliente@correo.cl`
- `GET /productos`
- `GET /productos/search?q=sku-o-nombre&category=Zapatos&sale=true&stock=instock`
- `POST /productos/sync`
- `GET /categorias`
- `GET /regiones`
- `GET /comunas`
- `POST /crear-pedido`
- `POST /pagar`
- `POST /chatwoot/enviar-producto`
- `POST /chatwoot/etiquetas`

Todos los endpoints están protegidos por Basic Auth.
