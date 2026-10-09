const router=require('express').Router();
router.get('/platform-info', (req,res)=>res.json({
 terms_url:process.env.TOUMA_TERMS_URL||null,
 privacy_url:process.env.TOUMA_PRIVACY_URL||null,
 support_email:process.env.TOUMA_SUPPORT_EMAIL||null,
 store_url:process.env.TOUMA_STORE_URL||null,
 referral_url:process.env.TOUMA_PUBLIC_URL||null
}));
module.exports=router;
