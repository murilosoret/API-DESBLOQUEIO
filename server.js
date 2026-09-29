const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

app.use(cors({
    origin: [
        'https://axiomsoft.com.br',
        'https://www.axiomsoft.com.br',
        'http://localhost:5173',
        'http://localhost:3000',
    ],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-senha'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
app.use(express.json());

const SENHA_ADMIN = process.env.SENHA_ADMIN || 'MINHA_SENHA_123';

// Rate limit no login (evita brute force)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutos
    max: 5,                      // 5 tentativas por IP
    message: { erro: 'Muitas tentativas de login. Aguarde 15 minutos.' }
});

// =============================================
// CONEXÃO COM O BANCO POSTGRESQL
// =============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Testar conexão
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Erro ao conectar ao PostgreSQL:', err.message);
    } else {
        console.log('✅ Conectado ao PostgreSQL no Neon');
        release();
    }
});

// =============================================
// FUNÇÕES AUXILIARES
// =============================================
function limparCnpj(cnpj) {
    if (!cnpj) return '';
    // Para CNPJ alfanumérico, mantém letras e números
    // Remove apenas caracteres especiais como . / - 
    return cnpj.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function formatarCnpj(cnpj) {
    const limpo = limparCnpj(cnpj);
    if (limpo.length !== 14) return cnpj;

    // Formata o CNPJ alfanumérico
    // Exemplo: 12ABC34501DE35 -> 12.ABC.345/01DE-35
    const primeiro = limpo.substring(0, 2);
    const segundo = limpo.substring(2, 5);
    const terceiro = limpo.substring(5, 8);
    const quarto = limpo.substring(8, 12);
    const quinto = limpo.substring(12, 14);

    return `${primeiro}.${segundo}.${terceiro}/${quarto}-${quinto}`;
}

// =============================================
// VALIDAÇÃO DE CNPJ (ALFANUMÉRICO OU NUMÉRICO)
// =============================================
function validarCnpjFormat(cnpj) {
    if (!cnpj) return false;

    // Verifica se tem 14 caracteres após limpeza
    const limpo = limparCnpj(cnpj);
    if (limpo.length !== 14) return false;

    // Verifica se é um CNPJ alfanumérico válido
    // Padrão: 12.ABC.345/01DE-35
    const regex = /^(\d{2})\.([A-Z0-9]{3})\.(\d{3})\/([A-Z0-9]{4})-(\d{2})$/;
    return regex.test(cnpj);
}

// =============================================
// MIDDLEWARE: aceita x-senha OU JWT
// =============================================
function authOuSenha(req, res, next) {
    // 1) x-senha (JavaFX desktop legado)
    if (req.headers['x-senha'] === SENHA_ADMIN) {
        return next();
    }

    // 2) JWT (site web novo)
    const header = req.headers['authorization'];
    if (header && header.startsWith('Bearer ')) {
        try {
            req.user = jwt.verify(header.replace('Bearer ', ''), process.env.JWT_SECRET);
            return next();
        } catch (e) {
            // token inválido, cai no 401 abaixo
        }
    }

    return res.status(401).json({ erro: 'Não autenticado' });
}

// =============================================
// ROTA: REGISTRAR EMPRESA
// =============================================
app.post('/registrar', async (req, res) => {
    const { cnpj, razao_social, nome_fantasia, email, telefone, plano, valor_mensal } = req.body;

    const cnpjLimpo = limparCnpj(cnpj);
    const cnpjFormatado = formatarCnpj(cnpjLimpo);

    if (!cnpjLimpo || (!razao_social && !nome_fantasia)) {
        return res.status(400).json({
            erro: 'CNPJ e RAZAO_SOCIAL ou NOME_FANTASIA são obrigatórios'
        });
    }

    // Validar formato do CNPJ (aceita alfanumérico)
    if (cnpjLimpo.length !== 14) {
        return res.status(400).json({
            erro: 'CNPJ inválido. O CNPJ deve ter 14 caracteres (incluindo letras para alfanumérico)'
        });
    }

    try {
        // Verificar se empresa já existe
        const result = await pool.query(
            'SELECT COD_EMP, CNPJ, NOME_FANTASIA, BLOQUEADO FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (result.rows.length > 0) {
            const empresa = result.rows[0];

            // Verificar parcelas pendentes
            const parcelasResult = await pool.query(
                `SELECT COUNT(*) as total FROM PARCELAS 
                 WHERE COD_EMP = $1 AND PAGO = FALSE AND DATA_VENCIMENTO < CURRENT_DATE`,
                [empresa.cod_emp]
            );

            const temPendencia = parcelasResult.rows[0].total > 0;
            const liberado = !empresa.bloqueado && !temPendencia;

            return res.json({
                sucesso: true,
                mensagem: 'Empresa já cadastrada',
                cod_emp: empresa.cod_emp,
                liberado: liberado,
                pendente: temPendencia
            });
        }

        // Empresa nova - cadastrar
        const nomeRazaosocial = razao_social || nome_fantasia;
        const nomeFantasiaFinal = nome_fantasia || razao_social;

        const insertResult = await pool.query(
            `INSERT INTO EMPRESAS 
             (CNPJ, RAZAO_SOCIAL, NOME_FANTASIA, EMAIL, TELEFONE, PLANO, VALOR_MENSAL, DATA_CADASTRO, ATIVO, BLOQUEADO) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), TRUE, TRUE) 
             RETURNING COD_EMP`,
            [cnpjFormatado, nomeRazaosocial, nomeFantasiaFinal, email || null, telefone || null, plano || 'MENSAL', valor_mensal || 130.00]
        );

        const codEmp = insertResult.rows[0].cod_emp;

        // Gerar 12 parcelas para o primeiro ano
        const hoje = new Date();
        for (let i = 1; i <= 12; i++) {
            const vencimento = new Date(hoje);
            vencimento.setMonth(hoje.getMonth() + i);
            const dataVencimento = vencimento.toISOString().split('T')[0];

            await pool.query(
                `INSERT INTO PARCELAS (COD_EMP, NUMERO_PARCELA, VALOR, DATA_VENCIMENTO, PAGO) 
                 VALUES ($1, $2, $3, $4, FALSE)`,
                [codEmp, i, valor_mensal || 130.00, dataVencimento]
            );
        }

        console.log(`✅ Nova empresa cadastrada: ${cnpjLimpo} - ${nomeFantasiaFinal}`);

        res.json({
            sucesso: true,
            mensagem: 'Empresa cadastrada com sucesso',
            cod_emp: codEmp,
            liberado: false,
            pendente: true
        });

    } catch (error) {
        console.error('Erro ao registrar empresa:', error);
        res.status(500).json({ erro: 'Erro interno ao cadastrar empresa' });
    }
});

// =============================================
// ROTA: VERIFICAR SE ESTÁ LIBERADO
// =============================================
app.get('/verificar/:cnpj', async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    try {
        const result = await pool.query(
            'SELECT COD_EMP, BLOQUEADO FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (result.rows.length === 0) {
            return res.json({
                liberado: false,
                cadastrado: false,
                mensagem: 'Empresa não cadastrada'
            });
        }

        const empresa = result.rows[0];

        const parcelasResult = await pool.query(
            `SELECT COUNT(*) as total FROM PARCELAS 
             WHERE COD_EMP = $1 AND PAGO = FALSE AND DATA_VENCIMENTO < CURRENT_DATE`,
            [empresa.cod_emp]
        );

        const temPendencia = parcelasResult.rows[0].total > 0;
        const liberado = !empresa.bloqueado && !temPendencia;

        res.json({
            liberado: liberado,
            cadastrado: true,
            pendente: temPendencia,
            parcelas_vencidas: parcelasResult.rows[0].total
        });

    } catch (error) {
        console.error('Erro ao verificar:', error);
        res.status(500).json({ erro: 'Erro ao verificar status' });
    }
});

// =============================================
// ROTA: LISTAR TODAS EMPRESAS (ADMIN)
// =============================================
app.get('/empresas', authOuSenha, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                E.COD_EMP as "COD_EMP",
                E.CNPJ as "CNPJ",
                E.NOME_FANTASIA as "NOME_FANTASIA",
                E.RAZAO_SOCIAL as "RAZAO_SOCIAL",
                E.EMAIL as "EMAIL",
                E.BLOQUEADO as "BLOQUEADO",
                E.MOTIVO_BLOQUEIO as "MOTIVO_BLOQUEIO",
                E.PLANO as "PLANO",
                E.VALOR_MENSAL as "VALOR_MENSAL",
                TO_CHAR(E.DATA_CADASTRO, 'DD/MM/YYYY') as "DATA_CADASTRO",
                COUNT(P.COD_PAR) as "TOTAL_PARCELAS",
                COUNT(CASE WHEN P.PAGO = TRUE THEN 1 END) as "TOTAL_PAGAS",
                COUNT(CASE WHEN P.PAGO = FALSE AND P.DATA_VENCIMENTO < CURRENT_DATE THEN 1 END) as "VENCIDAS",
                COUNT(CASE WHEN P.PAGO = FALSE AND P.DATA_VENCIMENTO >= CURRENT_DATE THEN 1 END) as "NAO_VENCIDAS"
            FROM EMPRESAS E
            LEFT JOIN PARCELAS P ON E.COD_EMP = P.COD_EMP
            GROUP BY 
                E.COD_EMP, E.CNPJ, E.NOME_FANTASIA, E.RAZAO_SOCIAL, E.EMAIL, 
                E.BLOQUEADO, E.MOTIVO_BLOQUEIO, E.PLANO, E.VALOR_MENSAL, E.DATA_CADASTRO
        `);

        res.json({ empresas: result.rows });

    } catch (error) {
        console.error('Erro ao listar empresas:', error);
        res.status(500).json({ erro: 'Erro ao listar empresas' });
    }
});

// =============================================
// ROTA: LISTAR PARCELAS DE UMA EMPRESA
// =============================================
app.get('/parcelas/:cnpj', authOuSenha, async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    try {
        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;

        const parcelasResult = await pool.query(
            `SELECT 
                NUMERO_PARCELA as numero_parcela,
                VALOR::DECIMAL(10,2) as valor,
                DATA_VENCIMENTO as data_vencimento,
                DATA_PAGAMENTO as data_pagamento,
                PAGO as pago,
                JUROS::DECIMAL(10,2) as juros,
                MULTA::DECIMAL(10,2) as multa,
                FORMA_PAGAMENTO as forma_pagamento,
                STATUS as status
             FROM PARCELAS 
             WHERE COD_EMP = $1 
             ORDER BY NUMERO_PARCELA ASC`,
            [codEmp]
        );

        console.log(`📦 Parcelas encontradas: ${parcelasResult.rows.length}`);
        res.json({ parcelas: parcelasResult.rows });

    } catch (error) {
        console.error('Erro ao listar parcelas:', error);
        res.status(500).json({ erro: 'Erro ao listar parcelas' });
    }
});

// =============================================
// ROTA: LIBERAR EMPRESA
// =============================================
app.post('/liberar/:cnpj', authOuSenha, async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    try {
        const result = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = result.rows[0].cod_emp;

        await pool.query(
            'UPDATE EMPRESAS SET BLOQUEADO = FALSE, MOTIVO_BLOQUEIO = NULL WHERE COD_EMP = $1',
            [codEmp]
        );

        res.json({ liberado: true, cnpj: cnpj });

    } catch (error) {
        console.error('Erro ao liberar:', error);
        res.status(500).json({ erro: 'Erro ao liberar empresa' });
    }
});

// =============================================
// ROTA: BLOQUEAR EMPRESA
// =============================================
app.delete('/bloquear/:cnpj', authOuSenha, async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    try {
        const result = await pool.query(
            'UPDATE EMPRESAS SET BLOQUEADO = TRUE, MOTIVO_BLOQUEIO = $1 WHERE CNPJ = $2',
            ['BLOQUEIO_MANUAL', cnpjFormatado]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        res.json({ sucesso: true, bloqueado: true, cnpj: cnpj });

    } catch (error) {
        console.error('Erro ao bloquear:', error);
        res.status(500).json({ erro: 'Erro ao bloquear empresa' });
    }
});

// =============================================
// ROTA: DAR BAIXA EM UMA PARCELA
// =============================================
app.post('/baixar-parcela/:cnpj/:numero', authOuSenha, async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);
    const numero = parseInt(req.params.numero);
    const { forma_pagamento } = req.body;

    console.log(`📌 Baixar parcela - CNPJ: ${cnpj}, Parcela: ${numero}, Forma: ${forma_pagamento}`);

    try {
        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;

        const result = await pool.query(
            `UPDATE PARCELAS 
             SET PAGO = TRUE, 
                 DATA_PAGAMENTO = CURRENT_DATE, 
                 FORMA_PAGAMENTO = $1,
                 STATUS = 'PAGA'
             WHERE COD_EMP = $2 AND NUMERO_PARCELA = $3`,
            [forma_pagamento, codEmp, numero]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ erro: 'Parcela não encontrada' });
        }

        console.log(`✅ Parcela ${numero} da empresa ${cnpj} recebeu baixa`);
        res.json({ sucesso: true, mensagem: 'Baixa realizada com sucesso' });

    } catch (error) {
        console.error('❌ Erro ao dar baixa:', error);
        res.status(500).json({ erro: 'Erro ao dar baixa na parcela', detalhe: error.message });
    }
});

// =============================================
// ROTA: CANCELAR BAIXA DE UMA PARCELA
// =============================================
app.post('/cancelar-baixa-parcela/:cnpj/:numero', authOuSenha, async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);
    const numero = parseInt(req.params.numero);

    console.log(`📌 Cancelar baixa - CNPJ: ${cnpj}, Parcela: ${numero}`);

    try {
        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;

        await pool.query(
            `UPDATE PARCELAS 
             SET PAGO = FALSE, 
                 DATA_PAGAMENTO = NULL, 
                 FORMA_PAGAMENTO = NULL,
                 STATUS = CASE 
                     WHEN DATA_VENCIMENTO < CURRENT_DATE THEN 'ATRASADA'
                     ELSE 'PENDENTE'
                 END
             WHERE COD_EMP = $1 AND NUMERO_PARCELA = $2`,
            [codEmp, numero]
        );

        console.log(`✅ Baixa da parcela ${numero} cancelada com sucesso`);
        res.json({ sucesso: true, mensagem: 'Baixa cancelada com sucesso' });

    } catch (error) {
        console.error('❌ Erro ao cancelar baixa:', error);
        res.status(500).json({ erro: 'Erro ao cancelar baixa', detalhe: error.message });
    }
});

// =============================================
// ROTA: GERAR MÚLTIPLAS PARCELAS
// =============================================
app.post('/gerar-parcelas/:cnpj', authOuSenha, async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);
    const { parcelas } = req.body;

    console.log(`📌 Gerar parcelas - CNPJ: ${cnpj}`);
    console.log(`📦 Parcelas a gerar: ${parcelas.length}`);

    try {
        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;

        const maxParcelaResult = await pool.query(
            'SELECT MAX(NUMERO_PARCELA) as max FROM PARCELAS WHERE COD_EMP = $1',
            [codEmp]
        );

        let proximoNumero = (maxParcelaResult.rows[0].max || 0) + 1;
        console.log(`📌 Próximo número de parcela: ${proximoNumero}`);

        let inseridas = 0;
        for (const parcela of parcelas) {
            let status = 'PENDENTE';
            const dataVencimento = new Date(parcela.data_vencimento);
            const hoje = new Date();
            hoje.setHours(0, 0, 0, 0);

            if (parcela.pago) {
                status = 'PAGA';
            } else if (dataVencimento < hoje) {
                status = 'ATRASADA';
            }

            const result = await pool.query(
                `INSERT INTO PARCELAS 
                 (COD_EMP, NUMERO_PARCELA, VALOR, DATA_VENCIMENTO, PAGO, STATUS, FORMA_PAGAMENTO) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [codEmp, proximoNumero, parcela.valor, parcela.data_vencimento, parcela.pago || false, status, null]
            );

            if (result.rowCount > 0) {
                inseridas++;
                proximoNumero++;
            }
        }

        console.log(`✅ Geradas ${inseridas} parcelas para empresa ${cnpj}`);
        res.json({ sucesso: true, mensagem: `${inseridas} parcelas geradas com sucesso` });

    } catch (error) {
        console.error('❌ Erro ao gerar parcelas:', error);
        res.status(500).json({ erro: 'Erro ao gerar parcelas', detalhe: error.message });
    }
});

// =============================================
// ROTA: ALTERNAR BLOQUEIO MANUAL (Toggle)
// =============================================
app.post('/empresa/:cnpj/toggle-bloqueio', authOuSenha, async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    try {
        const empresaResult = await pool.query(
            'SELECT BLOQUEADO FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const bloqueadoAtual = empresaResult.rows[0].bloqueado === true;
        const novoBloqueio = !bloqueadoAtual;
        const motivo = novoBloqueio ? 'BLOQUEIO_MANUAL_ADMIN' : 'DESBLOQUEIO_MANUAL_ADMIN';

        await pool.query(
            'UPDATE EMPRESAS SET BLOQUEADO = $1, MOTIVO_BLOQUEIO = $2 WHERE CNPJ = $3',
            [novoBloqueio, motivo, cnpjFormatado]
        );

        console.log(`✅ Empresa ${cnpj} - Bloqueio manual: ${novoBloqueio ? 'BLOQUEADA' : 'DESBLOQUEADA'}`);

        res.json({
            sucesso: true,
            bloqueado: novoBloqueio,
            mensagem: novoBloqueio ? 'Empresa bloqueada manualmente' : 'Empresa desbloqueada manualmente'
        });

    } catch (error) {
        console.error('Erro ao alternar bloqueio:', error);
        res.status(500).json({ erro: 'Erro ao alternar bloqueio' });
    }
});

// =============================================
// ROTA: VERIFICAR BLOQUEIO COM TOLERÂNCIA DE 15 DIAS
// =============================================
app.get('/empresa/:cnpj/status-bloqueio', async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    console.log(`🔍 Buscando empresa com CNPJ: ${cnpjFormatado}`);

    try {
        const empresaResult = await pool.query(
            'SELECT COD_EMP, BLOQUEADO, MOTIVO_BLOQUEIO FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.json({
                cadastrada: false,
                bloqueado: true,
                motivo: 'EMPRESA_NAO_CADASTRADA'
            });
        }

        const empresa = empresaResult.rows[0];

        // PRIORIDADE 1: BLOQUEIO (manual OU automático)
        if (empresa.bloqueado === true) {
            const motivo = empresa.motivo_bloqueio || 'BLOQUEIO_MANUAL';
            const isManual = motivo.toUpperCase().includes('MANUAL');

            // 🔥 Calcula os dias de atraso também (para mostrar no aviso)
            const parcelasResult = await pool.query(
                `SELECT 
            COUNT(*) as total,
            MIN(DATA_VENCIMENTO) as primeira_vencida
         FROM PARCELAS 
         WHERE COD_EMP = $1 AND PAGO = FALSE AND DATA_VENCIMENTO < CURRENT_DATE`,
                [empresa.cod_emp]
            );

            let diasAtraso = 0;
            if (parcelasResult.rows[0].total > 0) {
                const primeiraVencimento = new Date(parcelasResult.rows[0].primeira_vencida);
                const hoje = new Date();
                primeiraVencimento.setHours(0, 0, 0, 0);
                hoje.setHours(0, 0, 0, 0);
                diasAtraso = Math.floor((hoje - primeiraVencimento) / (1000 * 60 * 60 * 24));
            }

            return res.json({
                cadastrada: true,
                bloqueado: true,
                motivo: motivo,
                bloqueio_manual: isManual,   // 🔥 só true se for manual de verdade
                pode_desbloquear: true,
                nivel_aviso: 3,
                dias_atraso: diasAtraso,
                dias_restantes: 0,
                parcelas_vencidas: parcelasResult.rows[0].total
            });
        }

        // VERIFICAR PARCELAS ATRASADAS
        const parcelasResult = await pool.query(
            `SELECT 
                COUNT(*) as total,
                MIN(DATA_VENCIMENTO) as primeira_vencida
             FROM PARCELAS 
             WHERE COD_EMP = $1 AND PAGO = FALSE AND DATA_VENCIMENTO < CURRENT_DATE`,
            [empresa.cod_emp]
        );

        const temParcelasAtrasadas = parcelasResult.rows[0].total > 0;

        if (!temParcelasAtrasadas) {
            await pool.query(
                'UPDATE EMPRESAS SET data_ultimo_aviso = NULL, dias_aviso_enviado = 0, data_bloqueio_previsto = NULL WHERE COD_EMP = $1',
                [empresa.cod_emp]
            );
            return res.json({
                cadastrada: true,
                bloqueado: false,
                motivo: 'EM_DIA',
                nivel_aviso: 0,
                dias_atraso: 0,
                dias_restantes: 0
            });
        }

        // CALCULAR DIAS DE ATRASO
        const primeiraVencimento = new Date(parcelasResult.rows[0].primeira_vencida);
        const hoje = new Date();
        primeiraVencimento.setHours(0, 0, 0, 0);
        hoje.setHours(0, 0, 0, 0);

        const diasAtraso = Math.floor((hoje - primeiraVencimento) / (1000 * 60 * 60 * 24));

        console.log(`📊 Dias de atraso: ${diasAtraso}`);

        // Dias 1-3: Tolerância (sem aviso)
        if (diasAtraso <= 3) {
            await pool.query(
                'UPDATE EMPRESAS SET dias_aviso_enviado = 0, data_bloqueio_previsto = CURRENT_DATE + INTERVAL \'15 days\' WHERE COD_EMP = $1',
                [empresa.cod_emp]
            );

            return res.json({
                cadastrada: true,
                bloqueado: false,
                motivo: 'TOLERANCIA_INICIAL',
                nivel_aviso: 0,
                dias_atraso: diasAtraso,
                dias_restantes: 15 - diasAtraso
            });
        }

        // Dias 4-7: Aviso amarelo
        if (diasAtraso >= 4 && diasAtraso <= 7) {
            await pool.query(
                'UPDATE EMPRESAS SET data_ultimo_aviso = CURRENT_DATE, dias_aviso_enviado = 1, data_bloqueio_previsto = CURRENT_DATE + INTERVAL \'8 days\' WHERE COD_EMP = $1',
                [empresa.cod_emp]
            );

            const dataBloqueio = new Date();
            dataBloqueio.setDate(dataBloqueio.getDate() + (15 - diasAtraso));

            return res.json({
                cadastrada: true,
                bloqueado: false,
                motivo: 'AVISO_AMARELO',
                nivel_aviso: 1,
                dias_atraso: diasAtraso,
                dias_restantes: 15 - diasAtraso,
                data_bloqueio_previsto: dataBloqueio.toISOString().split('T')[0]
            });
        }

        // Dias 8-14: Aviso vermelho
        if (diasAtraso >= 8 && diasAtraso <= 14) {
            await pool.query(
                'UPDATE EMPRESAS SET data_ultimo_aviso = CURRENT_DATE, dias_aviso_enviado = 2, data_bloqueio_previsto = CURRENT_DATE + INTERVAL \'1 day\' WHERE COD_EMP = $1',
                [empresa.cod_emp]
            );

            const dataBloqueio = new Date();
            dataBloqueio.setDate(dataBloqueio.getDate() + (15 - diasAtraso));

            return res.json({
                cadastrada: true,
                bloqueado: false,
                motivo: 'AVISO_VERMELHO',
                nivel_aviso: 2,
                dias_atraso: diasAtraso,
                dias_restantes: 15 - diasAtraso,
                data_bloqueio_previsto: dataBloqueio.toISOString().split('T')[0]
            });
        }

        // Dias >= 15: BLOQUEIO EFETIVO
        if (diasAtraso >= 15) {
            await pool.query(
                'UPDATE EMPRESAS SET BLOQUEADO = TRUE, MOTIVO_BLOQUEIO = $1 WHERE COD_EMP = $2',
                ['BLOQUEIO_AUTOMATICO_15_DIAS', empresa.cod_emp]
            );

            return res.json({
                cadastrada: true,
                bloqueado: true,
                motivo: 'BLOQUEIO_AUTOMATICO',
                nivel_aviso: 3,
                dias_atraso: diasAtraso,
                bloqueio_manual: false,
                parcelas_vencidas: parcelasResult.rows[0].total
            });
        }

        return res.json({
            cadastrada: true,
            bloqueado: false,
            motivo: 'VERIFICADO',
            nivel_aviso: 0,
            dias_atraso: diasAtraso,
            dias_restantes: 15 - diasAtraso
        });

    } catch (error) {
        console.error('Erro ao verificar status:', error);
        res.status(500).json({ erro: 'Erro ao verificar status' });
    }
});

// =============================================
// ROTA INICIAL
// =============================================
app.get('/', (req, res) => {
    res.json({
        api: "API Desbloqueio - Funcionando com PostgreSQL!",
        status: "online",
        versao: "2.0.0"
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 API rodando na porta ${PORT} com PostgreSQL`);
});

// =============================================
// ROTAS: NOTIFICAÇÕES
// =============================================

// LISTAR notificações ativas (globais + da empresa, se codEmp informado)
app.get('/notificacoes', async (req, res) => {
    const codEmp = req.query.codEmp ? parseInt(req.query.codEmp) : null;

    try {
        // Limpa expiradas antes de listar
        await pool.query(
            `DELETE FROM notificacoes
             WHERE expira_em IS NOT NULL AND expira_em < now()`
        );

        let query, params;

        if (codEmp) {
            query = `
                SELECT cod_notif, titulo, mensagem, tipo, data_criacao, cod_emp, expira_em
                FROM notificacoes
                WHERE (cod_emp IS NULL OR cod_emp = $1)
                ORDER BY data_criacao DESC
                LIMIT 50
            `;
            params = [codEmp];
        } else {
            query = `
                SELECT cod_notif, titulo, mensagem, tipo, data_criacao, cod_emp, expira_em
                FROM notificacoes
                WHERE cod_emp IS NULL
                ORDER BY data_criacao DESC
                LIMIT 50
            `;
            params = [];
        }

        const result = await pool.query(query, params);
        res.json(result.rows);

    } catch (error) {
        console.error('❌ Erro ao listar notificações:', error);
        res.status(500).json({ erro: 'Erro ao listar notificações' });
    }
});

// CRIAR notificação (admin)
app.post('/notificacoes', authOuSenha, async (req, res) => {
    const { titulo, mensagem, tipo, codEmp, cod_emp, expira_em } = req.body;
    const empresaFinal = codEmp ?? cod_emp ?? null;

    if (!titulo || !mensagem) {
        return res.status(400).json({ erro: 'Título e mensagem são obrigatórios' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO notificacoes (titulo, mensagem, tipo, ativo, cod_emp, expira_em)
             VALUES ($1, $2, $3, TRUE, $4, $5)
             RETURNING cod_notif, titulo, mensagem, tipo, data_criacao, cod_emp, expira_em`,
            [
                titulo.trim(),
                mensagem.trim(),
                tipo || 'info',
                empresaFinal,
                expira_em || null,
            ]
        );

        console.log(`✅ Notificação criada: ${titulo}`);
        res.status(201).json(result.rows[0]);

    } catch (error) {
        console.error('❌ Erro ao criar notificação:', error);
        res.status(500).json({ erro: 'Erro ao criar notificação' });
    }
});

// DELETAR notificação DE VERDADE (hard delete)
app.delete('/notificacoes/:id', authOuSenha, async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM notificacoes WHERE cod_notif = $1',
            [parseInt(req.params.id)]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ erro: 'Notificação não encontrada' });
        }

        console.log(`🗑️ Notificação ${req.params.id} deletada`);
        res.json({ sucesso: true });

    } catch (error) {
        console.error('❌ Erro ao deletar notificação:', error);
        res.status(500).json({ erro: 'Erro ao deletar' });
    }
});

// =============================================
// MIDDLEWARE: AUTENTICAÇÃO JWT (usado em /me)
// =============================================
function auth(req, res, next) {
    const header = req.headers['authorization'];

    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Token não fornecido' });
    }

    const token = header.replace('Bearer ', '');

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (e) {
        return res.status(401).json({ erro: 'Token inválido ou expirado' });
    }
}

// =============================================
// ROTA: LOGIN
// =============================================
app.post('/login', loginLimiter, async (req, res) => {
    const { usuario, senha, tipo } = req.body;

    if (!usuario || !senha) {
        return res.status(400).json({ erro: 'Usuário e senha são obrigatórios' });
    }

    // Por enquanto só admin
    if (tipo === 'cliente') {
        return res.status(501).json({ erro: 'Área do cliente ainda não disponível' });
    }

    try {
        const r = await pool.query(
            'SELECT * FROM usuarios_admin WHERE usuario = $1 AND ativo = TRUE',
            [usuario]
        );

        if (r.rows.length === 0) {
            console.log(`❌ Login falhou - usuário não encontrado: ${usuario}`);
            return res.status(401).json({ erro: 'Usuário ou senha inválidos' });
        }

        const u = r.rows[0];
        const ok = await bcrypt.compare(senha, u.senha_hash);

        if (!ok) {
            console.log(`❌ Login falhou - senha inválida: ${usuario}`);
            return res.status(401).json({ erro: 'Usuário ou senha inválidos' });
        }

        const token = jwt.sign(
            {
                id: u.cod_admin,
                usuario: u.usuario,
                nome: u.nome,
                role: u.role
            },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        console.log(`✅ Login OK: ${usuario} (${u.role})`);

        res.json({
            token,
            user: {
                id: u.cod_admin,
                usuario: u.usuario,
                nome: u.nome,
                role: u.role
            }
        });

    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ erro: 'Erro interno no login' });
    }
});

// =============================================
// ROTA: VALIDAR TOKEN
// =============================================
app.get('/me', auth, async (req, res) => {
    try {
        const r = await pool.query(
            'SELECT cod_admin, usuario, nome, role, ativo FROM usuarios_admin WHERE cod_admin = $1',
            [req.user.id]
        );

        if (r.rows.length === 0 || !r.rows[0].ativo) {
            return res.status(401).json({ erro: 'Usuário inativo' });
        }

        res.json({ user: r.rows[0] });

    } catch (error) {
        console.error('Erro em /me:', error);
        res.status(500).json({ erro: 'Erro interno' });
    }
});

// =============================================
// ROTA: GERAR LICENÇA
// =============================================
const crypto = require('crypto');

app.post('/licencas/gerar', authOuSenha, async (req, res) => {
    const { cnpj, cliente, id_maquina } = req.body;

    if (!cnpj || !cliente || !id_maquina) {
        return res.status(400).json({ erro: 'CNPJ, cliente e ID da máquina são obrigatórios' });
    }

    const cnpjLimpo = cnpj.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (cnpjLimpo.length !== 14) {
        return res.status(400).json({ erro: 'CNPJ inválido' });
    }

    try {
        const privateKeyBase64 = process.env.PRIVATE_KEY_BASE64;
        if (!privateKeyBase64) {
            console.error('❌ PRIVATE_KEY_BASE64 não configurada');
            return res.status(500).json({ erro: 'Chave privada não configurada no servidor' });
        }

        // Aceita base64 puro (DER) ou PEM completo
        let privateKeyPem;
        if (privateKeyBase64.includes('-----BEGIN')) {
            privateKeyPem = privateKeyBase64;
        } else {
            // Remove quebras/espaços e reconstrói o PEM
            const limpo = privateKeyBase64.replace(/\s/g, '');
            const linhas = limpo.match(/.{1,64}/g).join('\n');
            privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${linhas}\n-----END PRIVATE KEY-----\n`;
        }

        // Validade: +1 ano
        const hoje = new Date();
        const validade = new Date(hoje);
        validade.setFullYear(validade.getFullYear() + 1);
        const validadeStr = validade.toISOString().split('T')[0];

        const licenca = {
            cnpj: cnpjLimpo,
            cliente: cliente.trim(),
            validade: validadeStr,
            plano: 'MENSAL',
            idMaquina: id_maquina.trim()
        };

        const jsonStr = JSON.stringify(licenca);
        const dadosBase64 = Buffer.from(jsonStr, 'utf8').toString('base64');

        const sign = crypto.createSign('RSA-SHA256');
        sign.update(dadosBase64);
        sign.end();
        const assinaturaBuffer = sign.sign(privateKeyPem);
        const assinaturaBase64 = assinaturaBuffer.toString('base64');

        const licencaFinal = {
            dados: dadosBase64,
            assinatura: assinaturaBase64
        };

        const arquivoJson = JSON.stringify(licencaFinal, null, 2);
        const arquivoBase64 = Buffer.from(arquivoJson, 'utf8').toString('base64');

        console.log(`✅ Licença gerada: ${cnpjLimpo} - ${cliente}`);

        res.json({
            sucesso: true,
            arquivo_base64: arquivoBase64,
            nome_arquivo: `${cnpjLimpo}.dat`
        });

    } catch (error) {
        console.error('❌ Erro ao gerar licença:', error);
        res.status(500).json({ erro: 'Erro ao gerar licença', detalhe: error.message });
    }
});