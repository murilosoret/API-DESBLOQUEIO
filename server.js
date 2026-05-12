const express = require('express');
const app = express();

app.use(express.json());

// Banco de dados em memória
let clientesLiberados = [];

// Rota para VERIFICAR se está liberado (usada pelo sistema do cliente)
app.get('/verificar/:cnpj', (req, res) => {
    const cnpj = req.params.cnpj;
    const liberado = clientesLiberados.includes(cnpj);
    console.log(`Verificação: ${cnpj} - Liberado: ${liberado}`);
    res.json({ liberado: liberado });
});

// Rota para MARCAR como liberado (usada por você)
app.post('/liberar/:cnpj', (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = req.params.cnpj;
    
    if (senha !== 'MINHA_SENHA_123') {
        return res.status(401).json({ erro: 'Senha inválida' });
    }
    
    if (!clientesLiberados.includes(cnpj)) {
        clientesLiberados.push(cnpj);
        console.log(`Cliente liberado: ${cnpj}`);
    }
    
    res.json({ liberado: true, cnpj: cnpj });
});

// Rota para listar todos liberados
app.get('/listar', (req, res) => {
    const senha = req.headers['x-senha'];
    if (senha !== 'MINHA_SENHA_123') {
        return res.status(401).json({ erro: 'Senha inválida' });
    }
    res.json({ liberados: clientesLiberados, total: clientesLiberados.length });
});

// Rota para remover liberação (se precisar bloquear de novo)
app.delete('/bloquear/:cnpj', (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = req.params.cnpj;
    
    if (senha !== 'MINHA_SENHA_123') {
        return res.status(401).json({ erro: 'Senha inválida' });
    }
    
    clientesLiberados = clientesLiberados.filter(c => c !== cnpj);
    console.log(`Cliente bloqueado: ${cnpj}`);
    res.json({ bloqueado: true, cnpj: cnpj });
});

// Rota inicial para testar se a API está no ar
app.get('/', (req, res) => {
    res.json({ 
        api: "API Desbloqueio - Funcionando!", 
        status: "online",
        versao: "1.0.0"
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 API rodando na porta ${PORT}`);
    console.log(`📋 Endpoints disponíveis:`);
    console.log(`   GET  /verificar/:cnpj`);
    console.log(`   POST /liberar/:cnpj`);
    console.log(`   GET  /listar`);
    console.log(`   DELETE /bloquear/:cnpj`);
    console.log(`   GET  /`);
});