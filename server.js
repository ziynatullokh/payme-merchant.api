import express from 'express'
import base64 from 'base-64'

const app = express()
app.use(express.json())

class PaymeMerchant {

    async CheckPerformTransaction (req, res) {
        const { params } = req.body
        const findDriver = await this.findDriver(params.account.callsign)

        if(!findDriver) return res.json(this.Error(req.body.id, -31099, "Haydovchi topilmadi", "callsign"))        
        else if(params.amount < 0 || params.amount > 10000000) return res.json(this.Error(req.body.id, -31001, "Summa xato", "amount"))
        else return res.json({ 
            result: { 
                allow: true, 
                additional: {
                    fullname: `${findDriver.last_name} ${findDriver.first_name}`
                },
                detail: { 
                    receipt_type: 0,
                    title: "Haydovchi hisobini to'ldirish",
                    price: params.amount,
                    count: 1,
                    code: "10107001002000000",
                    package_code: "1209869",
                    vat_percent: 0
                }
            }
        })
    }
    async CreateTransaction (req, res) {
        const { params } = req.body
        const findOrder = await telegram.db.merchant.findOne({
            callsign: params.account.callsign,
            merchant_id: params.id
        })

        const findDriver = await telegram.db.drivers.findOne({ callsign: params.account.callsign })

        if(!findDriver) return res.json(this.Error(0, -31099, "Haydovchi topilmadi", 'callsign'))
        
        else if(findOrder && findOrder.state == 1) {
            return res.json({ result: { create_time: findOrder.local_time, transaction: findOrder._id, state: findOrder.state } })
        }
        else if(params.amount < 0 || params.amount > 10000000) return res.json(this.Error(req.body.id, -31001, "Summa xato", "amount"))

        const local_time = Date.now()
        const state = 1

        const order = await telegram.db.merchant.insertOne({
            callsign: params.account.callsign,
            amount: params.amount,
            status: 'created',
            merchant_time: params.time,
            merchant_id: params.id,
            perform_time: 0,
            cancel_time: 0,
            local_time,
            state,
            reason: null
        })


        return res.json({ result: { create_time: local_time, transaction: order.insertedId, state } })
    }
    async CheckTransaction (req, res) {
        const { params } = req.body
        const findOrder = await telegram.db.merchant.findOne({ merchant_id: params.id })

        if(!findOrder) return res.json(this.Error(0, -31003, "Buyurtma topilmadi", "id"))
        return res.json({ result: { 
            create_time: findOrder.local_time, 
            cancel_time: findOrder.cancel_time, 
            transaction: findOrder._id, 
            state: findOrder.state,
            perform_time: findOrder.perform_time,
            reason: findOrder.reason
        }})
    }
    async PerformTransaction (req, res) {
        const { params } = req.body

        const findOrder = await this.findOrder(params.id)

        if(!findOrder) return res.json(this.Error(params.id, -31003, "Buyurtma topilmadi", 'id'))
        switch (findOrder.state){
            case 1: 
                const state = 2
                const perform_time = Date.now()
                telegram.db.merchant.updateOne({ merchant_id: params.id }, { $set: { status: "success", perform_time, state  } })
                
                res.json({ result: { transaction: findOrder._id, perform_time, state } })

                const findDriver = await telegram.db.drivers.findOne({ callsign: findOrder.callsign })
                const amount = ( findOrder.amount - ( findOrder.amount / 100 ) * 2) / 100
                const order = {
                    _id: params.id,
                    userid: 0,
                    driver_id: findDriver.id,
                    original_amount: findOrder.amount / 100, 
                    amount,
                    callsign: findOrder.callsign,
                    success_time: perform_time,
                    payme_status: "success",
                    from: "payme_merchant"
                }
                
                const ya_response = await telegram.ya_api.cash_transaction(order._id, order.driver_id, order.amount, "Deposit " + order._id)
                if(ya_response && ya_response.success){ order.ya_status = "success" }
                else { order.ya_status = ya_response.error?.message || ya_response.error }
                
                telegram.db.deposit.insertOne(order)
                const sms = `#PaymeSaytOrqali\n💴 Poziynoy: ${order.callsign}\nHisobingiz: ${order.amount} so'mga to'ldirildi.\nChek raqami: ${order._id}`
                MessageSendToChannel(sms)
                return 
            case 2: 
                return res.json({ result: { transaction: findOrder._id, perform_time: findOrder.perform_time, state: findOrder.state } });
            case -1:
                return res.json(this.Error(params.id, -31008, "Buyurtma bekor qilingan yoki to'langan", 'id'))
            case -2: 
                return res.json(this.Error(params.id, -31008, "Buyurtma bekor qilingan yoki to'langan", 'id'))
            default: res.json("Error");
            break;
        }
    }
    async CancelTransaction (req, res) {
        const { params } = req.body

        const findOrder = await this.findOrder(params.id)

        if(!findOrder) return res.json(this.Error(params.id, -31003, "Buyurtma topilmadi", 'id'))
        else if(findOrder.state == 1){
            const cancel_time = Date.now()

            telegram.db.merchant.updateOne({ merchant_id: params.id }, 
                { $set: { 
                    cancel_time, 
                    state: -1, 
                    reason: params.reason  
                } 
            })
            return res.json({ result: { 
                state: -1,
                cancel_time,
                transaction: findOrder.transaction || findOrder._id
            }})
        }
        else if(findOrder.state == 2) return res.json(this.Error(params.id, -31007, "Buyurtma bekor qilish imkoni mavjud emas", 'id'))
        else {
            return res.json({ result: {
                state: findOrder.state,
                cancel_time: findOrder.cancel_time,
                transaction: findOrder.transaction || findOrder._id
            } })
        }
    }

    Error(id, code, message, data){
        return {
            error: {
                code,
                message: {
                    uz: message,
                    ru: message,
                    en: message
                },
                data
            },
            id
        }
    }
}

const merchant = new PaymeMerchant()

app.post('/', (req, res, next) => {
    try{
        
        const key = req.headers.authorization?.replace("Basic ", '')
        const data = base64.decode(key)
        
        const [ login, password] = data.split(':')
        
        if(login != "Paycom" || password != config.payme_real_key) throw new Error("Key invalid")
    }catch(error){
        return next(error.message)
    }

    switch(req.body?.method){
        case "CheckPerformTransaction": merchant.CheckPerformTransaction(req, res); break;
        case "CreateTransaction": merchant.CreateTransaction(req, res); break;
        case "CheckTransaction":  merchant.CheckTransaction(req, res); break;
        case "PerformTransaction": merchant.PerformTransaction(req, res); break;
        case "CancelTransaction": merchant.CancelTransaction(req, res); break;
        default: res.json({ error: "Error Method" });
    }
})

app.use( (error, req, res, next) => {
    return res.json(merchant.Error(0, -32504, error, "authorization"))
})

app.listen(3231, () => console.log("Yandex Alo baraka run: " ,3231))
