var email1 = $('#email');
var email2 = $('#email2');
const emailInput = document.querySelectorAll('.email-valid');
const emailError = document.querySelectorAll('.error-email');

function validEmail(num) {
    var pattern = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
        validEmail = pattern.test(String(emailInput[num].value).toLowerCase());
    if (validEmail === false) {
        event.preventDefault();
        emailInput[num].classList.add('activeBad');
    } else {
        emailInput[num].classList.remove('activeBad');
        emailInput[num].classList.add('activeGood');
    }
}

function inputValidEmail(num){
    emailInput[num].addEventListener('input', ()=>{
        validEmail(num)
    })
}


