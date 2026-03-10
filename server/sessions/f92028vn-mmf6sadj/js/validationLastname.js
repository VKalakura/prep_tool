const lastnameInput = document.querySelectorAll('.lastname-valid');


function inputValidLastname(num){
    lastnameInput[num].addEventListener('input', ()=>{
        validLastname(num)
    })
}

function validLastname(num) {
    if (lastnameInput[num].value.length < 1) {
        lastnameInput[num].classList.add('activeBad');
        event.preventDefault();
    } else {
        lastnameInput[num].classList.remove('activeBad');
        lastnameInput[num].classList.add('activeGood');
    }
}

