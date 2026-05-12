# Chatwoot WooCommerce Flow Panel Pro Chile

Panel Node.js + Express protegido con Basic Auth y login visual. Integra WooCommerce, Flow, Chatwoot, RUT chileno, comunas/códigos postales de Chile y productos variables con atributos/variaciones.

## Mejoras incluidas

- Muestra productos simples y variables.
- Carga variaciones WooCommerce con SKU, precio, stock, atributos e imagen.
- Muestra atributos, categorías, etiquetas e imágenes del producto.
- Checkout chileno con RUT obligatorio, comuna y código postal automático.
- Usa comunas desde `data/starter-comunas-chile.csv` del plugin Chile Postcodes.
- Guarda RUT y comuna como `meta_data` en el pedido WooCommerce.
- Compatible con productos importados por AliDropship: expone metadatos relevantes `ali`, `alids`, `alidropship`, tracking y supplier cuando WooCommerce los devuelve por REST API.
- Botón para enviar producto o variación a conversación Chatwoot.
- Endpoint para aplicar etiquetas a conversaciones Chatwoot.
- Pago Flow en CLP.

## Variables de entorno EasyPanel

Copia `.env.example` y cambia los valores reales.

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
CHATWOOT_URL=https://chat.tudominio.cl
CHATWOOT_API_KEY=xxxxxxxxxxxxxxxxx
CHATWOOT_ACCOUNT_ID=1
REQUIRE_RUT=true
DEFAULT_POSTCODE=8320000
```

## EasyPanel

- Builder: Nixpacks
- Install command: `npm install`
- Build command: vacío
- Start command: `node server.js`
- Port: `3000`

## Chatwoot App Panel

Registra la URL:

```text
https://panel.tudominio.cl/?email={{contact.email}}&conversation_id={{conversation.id}}
```

También soporta:

```text
/cliente?email={{email_cliente}}
```

## Endpoints principales

- `GET /cliente?email=cliente@correo.cl`
- `GET /productos`
- `GET /comunas`
- `GET /validar-rut?rut=12345678-5`
- `POST /crear-pedido`
- `POST /pagar`
- `POST /chatwoot/enviar-producto`
- `POST /chatwoot/etiquetas`

Todos los endpoints están protegidos por Basic Auth.
